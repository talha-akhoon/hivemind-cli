const { inngest, agentKit } = require('./client');
const axios = require('axios');
const chalk = require('chalk');
const { createTrainingContainer } = require('../commands/container');

// Local job coordination functions
async function checkLocalJobClaim(jobId, agentId) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const lockDir = path.join(os.homedir(), '.hivemind', 'locks');
  const lockFile = path.join(lockDir, `job-${jobId}.lock`);

  console.log(chalk.cyan(`[Agent ${agentId}] Attempting to claim job ${jobId}...`));

  try {
    // Create locks directory if it doesn't exist
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    // Check if lock file already exists
    if (fs.existsSync(lockFile)) {
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const lockAge = Date.now() - new Date(lockData.timestamp).getTime();

      console.log(chalk.gray(`[Agent ${agentId}] Found existing lock by ${lockData.agentId}, age: ${Math.floor(lockAge/1000/60)} minutes`));

      // Check if the process that created the lock is still running
      const isProcessAlive = isProcessRunning(lockData.pid);

      // Clean up if lock is expired OR if the process is dead
      if (lockAge > 2 * 60 * 60 * 1000 || !isProcessAlive) {
        const reason = lockAge > 2 * 60 * 60 * 1000 ? 'expired' : 'process dead';
        console.log(chalk.yellow(`[Agent ${agentId}] Cleaning up ${reason} lock for job ${jobId} (was owned by ${lockData.agentId}, PID ${lockData.pid})`));
        fs.unlinkSync(lockFile);
      } else {
        // Lock still valid and owned by another agent
        if (lockData.agentId !== agentId) {
          console.log(chalk.gray(`[Agent ${agentId}] Job ${jobId} still locked by active agent ${lockData.agentId}`));
          return false;
        } else {
          console.log(chalk.green(`[Agent ${agentId}] Job ${jobId} already owned by this agent, refreshing lock`));
          return false;
        }
      }
    }

    // Create/update lock file
    const lockData = {
      jobId,
      agentId,
      timestamp: new Date().toISOString(),
      pid: process.pid
    };

    fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2));

    // Double-check we got the lock (race condition protection)
    await new Promise(resolve => setTimeout(resolve, 100));
    const verifyData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));

    const success = verifyData.agentId === agentId;
    if (success) {
      console.log(chalk.green(`[Agent ${agentId}] Successfully claimed job ${jobId}`));
    } else {
      console.log(chalk.red(`[Agent ${agentId}] Failed to claim job ${jobId}, locked by ${verifyData.agentId}`));
    }

    return success;

  } catch (error) {
    console.error(chalk.red(`[Agent ${agentId}] Error checking local job claim: ${error.message}`));
    return false;
  }
}

// Helper function to check if a process is still running
function isProcessRunning(pid) {
  try {
    // On Unix systems, sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Process doesn't exist or we don't have permission
    return false;
  }
}

async function releaseLocalJobClaim(jobId) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const lockDir = path.join(os.homedir(), '.hivemind', 'locks');
  const lockFile = path.join(lockDir, `job-${jobId}.lock`);

  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log(chalk.gray(`Released local lock for job ${jobId}`));
    }
  } catch (error) {
    console.error(chalk.red(`Error releasing local job claim: ${error.message}`));
  }
}

// Marketplace scanning function - replaces the polling loop
const scanMarketplaceFunction = inngest.createFunction(
  { id: 'scan-marketplace',
  onFailure: err => console.log('Scan Marketplace error:' + err),
  },
  [
    { cron: '*/1 * * * *' }, // Every minute (standard 5-field cron)
    { event: 'marketplace/scan-trigger' } // Manual trigger support
  ],
  async ({ event, step }) => {
    const API_BASE = process.env.HIVEMIND_API || 'http://localhost:3000/api';

    const jobs = await step.run('fetch-jobs', async () => {
      console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Scanning marketplace...`));
      try {
        const { data } = await axios.get(`${API_BASE}/jobs`);
        return data.filter(job => job.status === 'active');
      } catch (error) {
        console.error(chalk.red('Error fetching jobs:'), error.message || error);
        return [];
      }
    });

    if (jobs.length === 0) {
      console.log(chalk.gray('No active bounties found'));
      return { scanned: 0 };
    }

    // Send each job for evaluation
    await step.run('trigger-evaluations', async () => {
      for (const job of jobs) {
        await inngest.send({
          name: 'bounty/evaluate',
          data: { bounty: job }
        });
      }
    });

    console.log(chalk.blue(`Found ${jobs.length} bounties, sent for evaluation`));
    return { scanned: jobs.length };
  },

);

// Bounty evaluation function - determines profitability
const evaluateBountyFunction = inngest.createFunction(
  { id: 'evaluate-bounty', retries: 3, onFailure: err => console.log('Evaluate Bounty error:' + err) },
  { event: 'bounty/evaluate' },
  async ({ event, step }) => {
    const { bounty } = event.data;

    const config = await step.run('load-agent-config', async () => {
      const fs = require('fs').promises;
      const path = require('path');
      const os = require('os');
      const configFile = path.join(os.homedir(), '.hivemind', 'agent.json');
      try {
        const data = await fs.readFile(configFile, 'utf8');
        return JSON.parse(data);
      } catch (e) {
        throw new Error('Agent not configured. Run "hivemind init" first.');
      }
    });

    const evaluation = await step.run('evaluate-profitability', async () => {
      // Check if agent has required capabilities
      const hasCapability = bounty.required_capabilities?.some(cap =>
        config.capabilities?.includes(cap)
      ) ?? true;

      if (!hasCapability) {
        return { profitable: false, reason: 'Missing required capabilities' };
      }

      // Calculate estimated cost and ROI
      const estimatedCost = calculateEstimatedCost(bounty);
      const reward = parseFloat(bounty.compute_budget || 0);
      const roi = reward / estimatedCost;

      const profitable = roi >= (config.minROI || 1.2);

      return {
        profitable,
        roi,
        estimatedCost,
        reward,
        reason: profitable ? 'ROI meets threshold' : 'ROI below threshold'
      };
    });

    // Check local claim status before proceeding
    if (evaluation.profitable) {
      const localClaimed = await step.run('check-local-claim', async () => {
        // Create a unique agent instance ID that includes process ID
        const uniqueAgentId = `${config.machineId}-${process.pid}`;
        return await checkLocalJobClaim(bounty.id, uniqueAgentId);
      });

      if (!localClaimed) {
        console.log(chalk.gray(`Job ${bounty.title} already being processed by another local agent`));
        return { ...evaluation, localClaimed: false, reason: 'Job already claimed locally' };
      }

      console.log(chalk.yellow(`💰 Profitable bounty claimed locally: ${bounty.title}`));
      console.log(`   Reward: ${chalk.yellow(bounty.compute_budget + ' HBAR')}`);
      console.log(`   Expected ROI: ${chalk.green(evaluation.roi.toFixed(2) + 'x')}`);

      // Trigger training execution
      await step.run('start-training', async () => {
        await inngest.send({
          name: 'training/execute',
          data: {
            bounty,
            evaluation: { ...evaluation, localClaimed: true },
            agentConfig: config
          }
        });
      });
    }

    return evaluation;
  }
);

// Training execution function - handles the actual ML training
const executeTrainingFunction = inngest.createFunction(
  {
    id: 'execute-training',
    retries: 2,
    timeout: '160m', // 60 minute timeout for training,
    onFailure: err => console.log('Execute Training error:' + err)
  },
  { event: 'training/execute' },
  async ({ event, step }) => {
    const { bounty, evaluation, agentConfig } = event.data;

    console.log(chalk.blue(`🏁 Starting training for: ${bounty.title}`));

    const containerInfo = await step.run('create-container', async () => {
      const container = await createTrainingContainer(bounty, {
        // Access data would be fetched here
      });

      // Return only serializable data, not the container object
      return {
        id: container.id,
        image: bounty.image || 'python:3.9-slim'
      };
    });

    const trainingResult = await step.run('run-training', async () => {
      console.log(chalk.blue('🔄 Training in progress...'));

      // Recreate the Docker container object from the ID
      const Docker = require('dockerode');
      const docker = new Docker();
      const container = docker.getContainer(containerInfo.id);

      // Execute the training script in the already-running container
      const exec = await container.exec({
        Cmd: ['bash', '/workspace/run.sh'],
        AttachStdout: true,
        AttachStderr: true
      });

      const stream = await exec.start();

      return new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => {
          reject(new Error('Training timeout'));
        }, 55 * 60 * 1000); // 55 minutes

        stream.on('data', (chunk) => {
          const data = chunk.toString();
          output += data;

          // Log all output for debugging
          console.log(chalk.gray(data.trim()));

          // Log progress indicators
          if (data.includes('Epoch') || data.includes('Loss')) {
            console.log(chalk.green(data.trim()));
          }

          // Log errors
          if (data.includes('ERROR') || data.includes('Error') || data.includes('Traceback')) {
            console.log(chalk.red(data.trim()));
          }
        });

        stream.on('end', async () => {
          clearTimeout(timeout);

          try {
            // Get the exit code of the exec command
            const execInfo = await exec.inspect();

            if (execInfo.ExitCode === 0) {
              // Extract and properly encode results from container
              console.log(chalk.blue('📦 Extracting model files...'));
              const resultsArchive = await container.getArchive({ path: '/output' });

              // Convert stream to buffer for proper transmission
              const chunks = [];
              for await (const chunk of resultsArchive) {
                chunks.push(chunk);
              }
              const resultsBuffer = Buffer.concat(chunks);

              console.log(chalk.green(`✅ Extracted ${resultsBuffer.length} bytes of model data`));

              resolve({
                success: true,
                output,
                results: resultsBuffer.toString('base64'), // Encode as base64 for transmission
                resultsSize: resultsBuffer.length,
                metrics: extractMetrics(output)
              });
            } else {
              reject(new Error(`Training failed with code ${execInfo.ExitCode}`));
            }
          } catch (error) {
            reject(error);
          }
        });

        stream.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    });

    // Clean up container and release local job claim
    await step.run('cleanup', async () => {
      try {
        const Docker = require('dockerode');
        const docker = new Docker();
        const container = docker.getContainer(containerInfo.id);
        await container.remove({ force: true });
      } catch (e) {
        console.log(chalk.yellow('Warning: Failed to clean up container'));
      }

      // Release local job claim
      await releaseLocalJobClaim(bounty.id);
    });

    if (trainingResult.success) {
      console.log(chalk.green(`✅ Training completed for: ${bounty.title}`));

      // Trigger result submission
      await step.run('submit-results', async () => {
        await inngest.send({
          name: 'results/submit',
          data: {
            bounty,
            trainingResult,
            agentConfig
          }
        });
      });
    }

    return trainingResult;
  }
);

// Results submission function
const submitResultsFunction = inngest.createFunction(
  { id: 'submit-results', retries: 3, onFailure: err => console.log('Submit results error:' + err) },
  { event: 'results/submit' },
  async ({ event, step }) => {
    const { bounty, trainingResult, agentConfig } = event.data;

    const submission = await step.run('submit-to-marketplace', async () => {
      const API_BASE = process.env.HIVEMIND_API || 'http://localhost:3000/api';

      try {
        console.log(chalk.blue('📤 Uploading trained model to marketplace...'));

        // Create FormData for file upload
        const FormData = require('form-data');
        const form = new FormData();

        // Convert base64 back to buffer for upload
        const modelBuffer = Buffer.from(trainingResult.results, 'base64');

        // Add the model file as a tar archive
        form.append('modelFile', modelBuffer, {
          filename: `model-${bounty.id}.tar`,
          contentType: 'application/x-tar'
        });

        // Add metadata as JSON
        form.append('agentId', agentConfig.machineId);
        form.append('accountId', agentConfig.accountId);
        form.append('metrics', JSON.stringify(trainingResult.metrics));
        form.append('modelSize', trainingResult.resultsSize.toString());

        const response = await axios.post(`${API_BASE}/jobs/${bounty.id}/submit`, form, {
          headers: {
            ...form.getHeaders(),
            'Content-Length': form.getLengthSync()
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        });

        console.log(chalk.green(`✅ Model uploaded successfully (${trainingResult.resultsSize} bytes)`));
        return response.data;
      } catch (error) {
        throw new Error(`Submission failed: ${error.message}`);
      }
    });

    console.log(chalk.green(`🎉 Results submitted for bounty: ${bounty.title}`));

    // Track earnings
    await step.run('track-earnings', async () => {
      await inngest.send({
        name: 'agent/earnings-update',
        data: {
          bountyId: bounty.id,
          amount: bounty.compute_budget,
          agentId: agentConfig.machineId
        }
      });
    });

    return submission;
  }
);

// Agent monitoring function
const monitorAgentFunction = inngest.createFunction(
  { id: 'monitor-agent', onFailure: err => console.log('Monitor Agent error: ' + err) },
  { cron: '*/10 * * * *' }, // Every 10 minutes (valid 5-field cron)
  async ({ event, step }) => {
    const metrics = await step.run('collect-metrics', async () => {
      const os = require('os');
      return {
        timestamp: new Date(),
        cpuUsage: os.loadavg(),
        memoryUsage: {
          total: os.totalmem(),
          free: os.freemem(),
          used: os.totalmem() - os.freemem()
        },
        uptime: os.uptime()
      };
    });

    // You could send these metrics to a monitoring service
    console.log(chalk.cyan(`📊 Agent metrics collected at ${metrics.timestamp.toLocaleTimeString()}`));

    return metrics;
  }
);

// Helper function to calculate estimated training cost
function calculateEstimatedCost(bounty) {
  // Simple cost estimation based on dataset size and complexity
  const baseCost = 0.1; // Base cost in HBAR
  const datasetSizeFactor = (bounty.dataset_size || 1000) / 1000;
  const complexityFactor = bounty.required_capabilities?.length || 1;

  return baseCost * datasetSizeFactor * complexityFactor;
}

// Helper function to extract training metrics from output
function extractMetrics(output) {
  const metrics = {};

  // Extract final accuracy/loss values
  const accuracyMatch = output.match(/accuracy[:\s]+([0-9.]+)/i);
  if (accuracyMatch) {
    metrics.accuracy = parseFloat(accuracyMatch[1]);
  }

  const lossMatch = output.match(/loss[:\s]+([0-9.]+)/i);
  if (lossMatch) {
    metrics.loss = parseFloat(lossMatch[1]);
  }

  return metrics;
}

module.exports = {
  scanMarketplaceFunction,
  evaluateBountyFunction,
  executeTrainingFunction,
  submitResultsFunction,
  monitorAgentFunction
};
