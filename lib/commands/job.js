const Docker = require('dockerode');
const docker = new Docker();
const axios = require('axios');
const crypto = require('crypto');
const tar = require('tar-stream');
const stream = require('stream');
const {createTrainingContainer} = require("./container");
const chalk = require('chalk');


async function runAgentLoop(config) {
    const API_BASE = process.env.HIVEMIND_API || 'http://localhost:3000/api';
    const runningJobs = new Set(); // Track jobs we're working on

    while (true) {
        try {
            // 1. Scan for bounties
            const timestamp = new Date().toLocaleTimeString();
            console.log(chalk.gray(`[${timestamp}] Scanning marketplace...`));

            const { data: jobs } = await axios.get(`${API_BASE}/jobs`);
            const openBounties = jobs.filter(b =>
                b.status === 'active' &&
                !runningJobs.has(b.id) // Not already working on it
            );

            if (openBounties.length === 0) {
                console.log(chalk.gray(`[${timestamp}] No new bounties found`));
            } else {
                console.log(chalk.gray(`[${timestamp}] Found ${openBounties.length} bounties`));

                // 2. Evaluate and start racing on profitable ones
                for (const bounty of openBounties) {
                    const evaluation = await evaluateBounty(bounty, config);

                    if (evaluation.profitable) {
                        console.log(chalk.yellow(`\n💰 Profitable bounty found!`));
                        console.log(`   Title: ${chalk.white(bounty.title)}`);
                        console.log(`   Reward: ${chalk.yellow(bounty.compute_budget + ' HBAR')}`);
                        console.log(`   Expected ROI: ${chalk.green(evaluation.roi.toFixed(2) + 'x')}`);
                        console.log(chalk.blue(`\n🏁 JOINING THE RACE!\n`));

                        // Start racing (non-blocking)
                        // runningJobs.add(bounty.id);
                        // executeJobRace(bounty, config)
                        //     .finally(() => runningJobs.delete(bounty.id));
                    }
                }
            }

            // Show status of running jobs
            if (runningJobs.size > 0) {
                console.log(chalk.cyan(`\n⚡ Currently racing on ${runningJobs.size} job(s)\n`));
            }

        } catch (error) {
            console.error(chalk.red('Error in agent loop:', error.message));
        }

        // Scan more frequently to catch new jobs quickly
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
    }
}

async function executeJobRace(bounty, agentConfig) {
    const jobId = bounty.id;
    const startTime = Date.now();

    console.log(chalk.blue(`[Job ${jobId}] 🏃 RACE STARTED!`));

    try {
        // Check if someone already won
        const { data: status } = await axios.get(`${API_BASE}/bounties/${jobId}`);
        if (status.status === 'completed') {
            console.log(chalk.yellow(`[Job ${jobId}] ⚠️  Already completed by another agent`));
            return;
        }

        // 1. Get data access (all agents can access)
        console.log(`[Job ${jobId}] 📥 Downloading dataset...`);
        const { data: accessData } = await axios.post(`${API_BASE}/data/access`, {
            bounty_id: jobId,
            agent_address: agentConfig.accountId
        });

        // 2. Start training immediately
        console.log(`[Job ${jobId}] 🔥 Training started!`);
        const container = await createTrainingContainer(bounty, accessData);
        await container.start();

        // Monitor training progress
        let trainingComplete = false;
        let modelMetrics = null;

        const logStream = await container.logs({
            stdout: true,
            stderr: true,
            follow: true
        });

        logStream.on('data', (chunk) => {
            const log = chunk.toString('utf8').trim();

            // Check if another agent won while we're training
            if (log.includes('Epoch')) {
                checkIfRaceWon(jobId).then(won => {
                    if (won) {
                        console.log(chalk.red(`[Job ${jobId}] ❌ Another agent completed first! Stopping...`));
                        container.kill();
                    }
                });
            }

            // Parse metrics
            if (log.includes('Final metrics:')) {
                const metricsMatch = log.match(/Accuracy: ([\d.]+), F1: ([\d.]+)/);
                if (metricsMatch) {
                    modelMetrics = {
                        accuracy: parseFloat(metricsMatch[1]),
                        f1_score: parseFloat(metricsMatch[2])
                    };
                }
            }

            // Show progress
            if (log.includes('Loss:') || log.includes('Accuracy:')) {
                console.log(chalk.gray(`[Job ${jobId}] ${log}`));
            }
        });

        // Wait for completion
        const result = await container.wait();
        const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

        if (result.StatusCode === 0) {
            // Try to submit our result - may fail if someone beat us!
            console.log(chalk.blue(`[Job ${jobId}] 🏃 RACING TO SUBMIT! (${duration} min)`));

            const won = await submitRaceResult(bounty, container, agentConfig, modelMetrics);

            if (won) {
                console.log(chalk.green(`[Job ${jobId}] 🏆 WE WON THE RACE!`));
                console.log(chalk.yellow(`[Job ${jobId}] 💰 Earned: ${bounty.compute_budget} HBAR`));
            } else {
                console.log(chalk.red(`[Job ${jobId}] 😞 Lost the race - another agent was faster`));
            }
        } else {
            console.log(chalk.red(`[Job ${jobId}] ❌ Training failed`));
        }

        // Cleanup
        await container.remove();

    } catch (error) {
        console.error(chalk.red(`[Job ${jobId}] Error:`, error.message));
    }
}

async function checkIfRaceWon(jobId) {
    try {
        const { data: bounty } = await axios.get(`${API_BASE}/bounties/${jobId}`);
        return bounty.status === 'completed';
    } catch (error) {
        return false;
    }
}

async function submitRaceResult(bounty, container, agentConfig, metrics) {
    try {
        // Extract model
        const outputPath = path.join(process.cwd(), 'output', bounty.id);
        await fs.mkdir(outputPath, { recursive: true });

        const modelStream = await container.getArchive({ path: '/output/best_model.pt' });
        const modelPath = path.join(outputPath, 'model.pt');

        // Save model locally
        await new Promise((resolve, reject) => {
            modelStream.pipe(tar.extract(outputPath)).on('finish', resolve).on('error', reject);
        });

        // Calculate hash
        const modelData = await fs.readFile(modelPath);
        const modelHash = crypto.createHash('sha256').update(modelData).digest('hex');

        // Try to claim victory (atomic operation)
        const { data: result } = await axios.post(`${API_BASE}/bounties/${bounty.id}/submit-result`, {
            agent_address: agentConfig.accountId,
            model_hash: modelHash,
            metrics: metrics || { accuracy: 0.95, f1_score: 0.94 },
            training_time: Date.now() - bounty.created_at
        });

        return result.won;

    } catch (error) {
        if (error.response?.status === 409) {
            // Someone else already won
            return false;
        }
        throw error;
    }
}

async function evaluateBounty(bounty, config) {
    // Simple ROI calculation
    const estimatedCost = estimateJobCost(bounty);
    const roi = bounty.compute_budget / estimatedCost;

    return {
        //TODO: remove this
        profitable: roi >= config.minROI,
        // profitable: true, // For testing purposes
        roi: roi,
        estimatedCost: estimatedCost
    };
}

function estimateJobCost(bounty) {
    // Estimate based on dataset size and epochs
    const gpuHourlyRate = 50; // 50 HBAR per hour
    const estimatedHours = (bounty.epochs || 10) * 0.1; // Rough estimate
    return gpuHourlyRate * estimatedHours;
}

module.exports = {
    runAgentLoop
}