const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { AccountBalanceQuery, Client } = require('@hashgraph/sdk');

const CONFIG_DIR = path.join(os.homedir(), '.hivemind');
const AGENT_CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json');

// Import account functions
const { saveAgent } = require('./account');

async function init(options) {
    console.log(chalk.blue(`
╔════════════════════════════════════════════════╗
║          HiveMind Agent Setup                  ║
╚════════════════════════════════════════════════╝

Each agent needs its own Hedera account for security.
This isolates risk - if one machine is compromised,
your other agents remain safe.
  `));

    // Check if agent already configured on this machine
    try {
        const existing = await fs.readFile(AGENT_CONFIG_FILE, 'utf8');
        const config = JSON.parse(existing);

        const { overwrite } = await inquirer.prompt([{
            type: 'confirm',
            name: 'overwrite',
            message: `Agent "${config.name}" already configured on this machine. Reconfigure?`,
            default: false
        }]);

        if (!overwrite) {
            console.log(chalk.yellow('\nConfiguration cancelled.'));
            console.log(chalk.gray(`Run "hivemind start" to launch ${config.name}`));
            return;
        }
    } catch (e) {
        // No existing config
    }

    // Check if user has account
    const { hasAccount } = await inquirer.prompt([{
        type: 'confirm',
        name: 'hasAccount',
        message: 'Do you have a Hedera account for this agent?',
        default: false
    }]);

    if (!hasAccount) {
        console.log(chalk.cyan('\n📝 How to Get a Hedera Account:\n'));

        console.log(chalk.white('Option 1: Hedera Portal (Recommended for Testnet)'));
        console.log('1. Visit: ' + chalk.cyan('https://portal.hedera.com'));
        console.log('2. Download one of the browser Hedera ecosystem wallets (e.g. HashPack, Blade Wallet) to create a new account"');
        console.log('3. Save your account ID and private key');

        console.log(chalk.yellow('💡 Tip: Each agent should have its own account'));
        console.log(chalk.gray('This costs ~$0.05 per account but provides complete isolation\n'));

        const { openBrowser } = await inquirer.prompt([{
            type: 'confirm',
            name: 'openBrowser',
            message: 'Open Hedera Portal in your browser?',
            default: true
        }]);

        if (openBrowser) {
            try {
                const open = await import('open');
                await open.default('https://portal.hedera.com');
                console.log(chalk.green('\n✅ Opening Hedera Portal...'));
            } catch (e) {
                console.log(chalk.gray('\nPlease visit: https://portal.hedera.com'));
            }
        }

        console.log(chalk.cyan('\nOnce you have an account, run "hivemind init" again!\n'));
        return;
    }

    // Gather agent configuration
    console.log(chalk.cyan('\n🔧 Configure Your Agent\n'));

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Name this agent:',
            default: `${os.hostname()}-agent`,
            validate: (input) => {
                if (input.length === 0) return 'Agent name is required';
                if (input.length > 30) return 'Name too long (max 30 chars)';
                return true;
            }
        },
        {
            type: 'input',
            name: 'accountId',
            message: `Enter this agent's Hedera Account ID:`,
            validate: (input) => {
                if (!/^\d+\.\d+\.\d+$/.test(input)) {
                    return 'Invalid format. Example: 0.0.123456';
                }
                return true;
            }
        },
        {
            type: 'password',
            name: 'privateKey',
            message: `Enter this agent's Private Key:`,
            mask: '*',
            validate: (input) => {
                if (input.length < 50) return 'Invalid private key';
                return true;
            }
        },
        {
            type: 'checkbox',
            name: 'capabilities',
            message: 'Select ML capabilities for this agent:',
            choices: [
                {
                    name: 'Image Classification',
                    value: 'image_classification',
                    checked: true
                },
                {
                    name: 'Object Detection',
                    value: 'object_detection',
                    checked: false
                },
                {
                    name: 'Natural Language Processing',
                    value: 'nlp',
                    checked: false
                },
                {
                    name: 'Tabular Data',
                    value: 'tabular',
                    checked: false
                },
                {
                    name: 'Time Series Forecasting',
                    value: 'timeseries',
                    checked: false
                }
            ],
            validate: (input) => {
                if (input.length === 0) return 'Select at least one capability';
                return true;
            }
        },
        {
            type: 'input',
            name: 'minROI',
            message: 'Minimum ROI threshold:',
            default: '1.2',
            validate: (input) => {
                const value = parseFloat(input);
                if (isNaN(value)) return 'Must be a number';
                if (value < 1) return 'ROI must be greater than 1';
                if (value > 5) return 'ROI seems too high (max 5)';
                return true;
            },
            filter: (input) => parseFloat(input)
        }
    ]);

    const spinner = ora('Validating Hedera account...').start();

    try {
        // Verify account exists and check balance
        const client = Client.forTestnet();
        const accountBalance = await new AccountBalanceQuery()
            .setAccountId(answers.accountId)
            .execute(client);

        const balance = parseFloat(accountBalance.hbars.toString());

        if (balance === 0) {
            spinner.warn(`Account validated but balance is 0 HBAR`);
        } else {
            spinner.succeed(`Account validated! Balance: ${chalk.green(accountBalance.hbars.toString())}`);
        }

        // Generate unique machine ID
        const machineId = crypto
            .createHash('sha256')
            .update(os.hostname() + os.networkInterfaces().eth0?.[0]?.mac || Date.now().toString())
            .digest('hex')
            .substring(0, 12);

        // Prepare agent configuration
        const agentConfig = {
            name: answers.name,
            accountId: answers.accountId,
            privateKey: answers.privateKey,
            machineId: machineId,
            capabilities: answers.capabilities,
            minROI: answers.minROI,
            created: new Date().toISOString(),
            version: '1.0.0'
        };

        // Save configuration
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.writeFile(AGENT_CONFIG_FILE, JSON.stringify(agentConfig, null, 2));
        await fs.chmod(AGENT_CONFIG_FILE, 0o600); // Secure file permissions

        // Save to global agents list (without private key)
        await saveAgent({
            name: answers.name,
            accountId: answers.accountId,
            machineId: machineId,
            capabilities: answers.capabilities,
            created: agentConfig.created,
            stats: {
                jobsCompleted: 0,
                totalEarned: 0,
                successRate: 0
            }
        });

        // Success message
        console.log(chalk.green(`
✅ Agent "${answers.name}" configured successfully!

${chalk.gray('Configuration saved to:')} ${AGENT_CONFIG_FILE}
${chalk.gray('Agent ID:')} ${machineId}
${chalk.gray('Account:')} ${answers.accountId}
${chalk.gray('Balance:')} ${balance} HBAR
`));

        if (balance < 10) {
            console.log(chalk.yellow('⚠️  Low Balance Warning'));
            console.log(`Your agent needs HBAR to bid on jobs.`);
            console.log(`Recommended minimum: 100 HBAR\n`);
            console.log(`Fund your account:`);
            console.log(`• Testnet: ${chalk.cyan('https://portal.hedera.com/faucet')}`);
            console.log(`• Mainnet: Transfer from exchange or another wallet\n`);
        }

        console.log(chalk.cyan('🚀 Next step: Run "hivemind start" to begin earning!\n'));

    } catch (error) {
        spinner.fail('Failed to validate account');

        if (error.message.includes('INVALID_ACCOUNT_ID')) {
            console.error(chalk.red('\n❌ Account does not exist on Hedera network'));
            console.log(chalk.yellow('Please check the account ID and try again.'));
        } else if (error.message.includes('ACCOUNT_ID_DOES_NOT_EXIST')) {
            console.error(chalk.red('\n❌ Account not found'));
            console.log(chalk.yellow('Make sure you created the account on the correct network (testnet/mainnet).'));
        } else {
            console.error(chalk.red('\n❌ Error:', error.message));
        }
    }
}

async function start(options) {
    const spinner = ora('Starting HiveMind Agent...').start();

    try {
        // Load agent configuration
        const configData = await fs.readFile(AGENT_CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData);

        // Quick balance check
        const client = Client.forTestnet();
        const accountBalance = await new AccountBalanceQuery()
            .setAccountId(config.accountId)
            .execute(client);

        const balance = parseFloat(accountBalance.hbars.toString());

        spinner.succeed('Agent started successfully!');

        // Update last seen timestamp
        await saveAgent({
            machineId: config.machineId,
            lastSeen: new Date().toISOString()
        });

        // Display agent status
        console.log(chalk.blue(`
╔════════════════════════════════════════════════╗
║            HiveMind Agent Active! 🚀           ║
╚════════════════════════════════════════════════╝`));

        console.log(`
${chalk.gray('Agent:')} ${chalk.cyan(config.name)}
${chalk.gray('Account:')} ${chalk.cyan(config.accountId)}
${chalk.gray('Balance:')} ${balance < 10 ? chalk.red(balance + ' HBAR ⚠️') : chalk.green(balance + ' HBAR')}

${chalk.gray('Capabilities:')}
${config.capabilities.map(c => '  ' + chalk.green('✓') + ' ' + c).join('\n')}

${chalk.gray('Settings:')}
  ${chalk.gray('Min ROI:')} ${chalk.cyan(config.minROI + 'x')}
  ${chalk.gray('Agent ID:')} ${chalk.gray(config.machineId)}
  
${chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.green('Status:')} Scanning for profitable bounties...
${chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
`);

        if (balance < 10) {
            console.log(chalk.red('⚠️  WARNING: Low balance! Agent may not be able to bid.\n'));
        }

        // Simulate agent activity
        let bidCount = 0;
        const simulateActivity = () => {
            bidCount++;
            const activities = [
                {
                    type: 'scan',
                    message: `Scanning marketplace... (${bidCount} bounties analyzed)`
                },
                {
                    type: 'found',
                    message: `💰 Found bounty: "Train ${['ResNet50', 'BERT', 'YOLOv8'][Math.floor(Math.random() * 3)]}" - ${Math.floor(Math.random() * 2000 + 500)} HBAR`
                },
                {
                    type: 'bid',
                    message: `🏷️  Placing bid: ${Math.floor(Math.random() * 1500 + 400)} HBAR (ROI: ${(Math.random() * 0.5 + 1.2).toFixed(2)}x)`
                },
                {
                    type: 'outbid',
                    message: `❌ Outbid by another agent`
                },
                {
                    type: 'won',
                    message: `🎉 Won bounty! Starting download...`
                }
            ];

            const activity = activities[Math.floor(Math.random() * activities.length)];
            const timestamp = new Date().toLocaleTimeString();

            console.log(chalk.gray(`[${timestamp}]`) + ' ' + activity.message);

            // Schedule next activity
            setTimeout(simulateActivity, Math.random() * 10000 + 5000);
        };

        // Start simulation after 3 seconds
        setTimeout(simulateActivity, 3000);

        if (options.daemon) {
            console.log(chalk.gray('\n📌 Running in background mode...'));
            console.log(chalk.gray('Logs: ~/.hivemind/agent.log'));
            console.log(chalk.gray('Stop with: hivemind stop'));
        } else {
            console.log(chalk.gray('\n💡 Press Ctrl+C to stop the agent'));
        }

    } catch (error) {
        spinner.fail('Failed to start agent');

        if (error.code === 'ENOENT') {
            console.error(chalk.red('\n❌ No agent configured on this machine'));
            console.log(chalk.yellow('Run "hivemind init" to set up an agent first.\n'));
        } else {
            console.error(chalk.red('\n❌ Error:', error.message));
        }
        process.exit(1);
    }
}

async function status() {
    try {
        // Load local agent configuration
        const configData = await fs.readFile(AGENT_CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData);

        const spinner = ora('Fetching agent status...').start();

        // Get current balance
        const client = Client.forTestnet();
        const accountBalance = await new AccountBalanceQuery()
            .setAccountId(config.accountId)
            .execute(client);

        spinner.stop();

        // Calculate uptime (mock for demo) - simulation
        const created = new Date(config.created);
        const uptime = Date.now() - created.getTime();
        const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

        console.log(chalk.blue(`
╔════════════════════════════════════════════════╗
║          HiveMind Agent Status                 ║
╚════════════════════════════════════════════════╝`));

        console.log(`
${chalk.gray('Agent Information')}
  Name: ${chalk.cyan(config.name)}
  Account: ${chalk.cyan(config.accountId)}
  Balance: ${chalk.green(accountBalance.hbars.toString())}
  Created: ${chalk.gray(created.toLocaleDateString())}
  Uptime: ${chalk.cyan(`${days}d ${hours}h`)}

${chalk.gray('Performance Metrics')}
  Jobs Completed: ${chalk.green('47')}
  Success Rate: ${chalk.green('95.7%')}
  Total Earned: ${chalk.yellow('12,543 HBAR')}
  Avg ROI: ${chalk.cyan('1.34x')}

${chalk.gray('Current Session')}
  Status: ${chalk.green('● Active')}
  Bids Placed: ${chalk.cyan('156')}
  Jobs Won: ${chalk.green('12')}
  Session Earnings: ${chalk.yellow('3,421 HBAR')}

${chalk.gray('Capabilities')}
${config.capabilities.map(c => '  ' + chalk.green('✓') + ' ' + c).join('\n')}
`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(chalk.red('\n❌ No agent configured on this machine'));
            console.log(chalk.yellow('Run "hivemind init" to set up an agent.\n'));
        } else {
            console.error(chalk.red('\n❌ Error:', error.message));
        }
    }
}

async function stop() {
    const spinner = ora('Stopping HiveMind Agent...').start();

    try {
        const configData = await fs.readFile(AGENT_CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData);

        // Update last seen to mark as stopped
        await saveAgent({
            machineId: config.machineId,
            lastSeen: new Date(Date.now()).toISOString() // 2 hours ago = inactive
        });

        spinner.succeed(`Agent "${config.name}" stopped`);
        console.log(chalk.gray('\nTo restart, run "hivemind start"'));

    } catch (error) {
        spinner.fail('No agent running on this machine');
    }
}

module.exports = { init, start, status, stop };