const { Client, AccountBalanceQuery } = require("@hashgraph/sdk");
const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const inquirer = require('inquirer');

const CONFIG_DIR = path.join(os.homedir(), '.hivemind');
const AGENTS_FILE = path.join(CONFIG_DIR, 'agents.json');

function getClient() {
    return Client.forTestnet();
}

async function create() {
    console.log(chalk.blue('\n🔗 Creating a Hedera Account\n'));

    console.log('For security and simplicity, please create accounts manually:\n');

    console.log(chalk.cyan('Option 1: Hedera Portal (Recommended)'));
    console.log('1. Visit: https://portal.hedera.com');
    console.log('2. Create a new account');
    console.log('3. Save your credentials securely');
    console.log('4. Get free testnet HBAR from the faucet\n');

    console.log(chalk.cyan('Option 2: Use HashPack Wallet'));
    console.log('1. Download HashPack: https://hashpack.app');
    console.log('2. Create a new account');
    console.log('3. Fund with HBAR\n');

    console.log(chalk.yellow('Why manual creation?'));
    console.log('• You control your keys from the start');
    console.log('• No need to trust our infrastructure');
    console.log('• Works immediately without setup\n');

    const { openPortal } = await inquirer.prompt([{
        type: 'confirm',
        name: 'openPortal',
        message: 'Open Hedera Portal in your browser?',
        default: true
    }]);

    if (openPortal) {
        const open = require('open');
        await open('https://portal.hedera.com');
    }

    console.log(chalk.green('\nOnce you have an account, run "hivemind init" to configure your agent!'));
}

// Check account balance
async function balance(options) {
    try {
        let accountId = options.account;

        if (!accountId) {
            const agents = await loadAgents();

            if (agents.length === 0) {
                console.log(chalk.yellow('\n📭 No agents configured yet.'));
                console.log(chalk.gray('Run "hivemind init" to set up your first agent.\n'));
                return;
            }

            console.log(chalk.blue('\n💰 Agent Balances\n'));
            console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

            let totalBalance = 0;
            const client = getClient();

            for (const agent of agents) {
                try {
                    const accountBalance = await new AccountBalanceQuery()
                        .setAccountId(agent.accountId)
                        .execute(client);

                    const hbarBalance = parseFloat(accountBalance.hbars.toString());
                    totalBalance += hbarBalance;

                    console.log(`${chalk.cyan(agent.name.padEnd(20))} ${agent.accountId.padEnd(12)} ${chalk.green(accountBalance.hbars.toString().padStart(12))}`);
                } catch (e) {
                    console.log(`${chalk.cyan(agent.name.padEnd(20))} ${agent.accountId.padEnd(12)} ${chalk.red('Error'.padStart(12))}`);
                }
            }

            console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            console.log(`${'Total'.padEnd(33)} ${chalk.green(totalBalance.toFixed(8) + ' ℏ'.padStart(12))}`);
            console.log();

            return;
        }

        // Check specific account
        const spinner = ora(`Checking balance for ${accountId}...`).start();

        const client = getClient();
        const accountBalance = await new AccountBalanceQuery()
            .setAccountId(accountId)
            .execute(client);

        spinner.succeed('Balance retrieved!');

        console.log(chalk.blue('\n💰 Account Balance\n'));
        console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(`Account: ${chalk.cyan(accountId)}`);
        console.log(`Balance: ${chalk.green(accountBalance.hbars.toString())}`);
        console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    } catch (error) {
        console.error(chalk.red('\n❌ Error:', error.message));
    }
}

async function list() {
    try {
        const agents = await loadAgents();

        if (agents.length === 0) {
            console.log(chalk.yellow('\n📭 No agents configured.'));
            console.log(chalk.gray('Run "hivemind init" to set up your first agent.\n'));
            return;
        }

        console.log(chalk.blue('\n🤖 Configured Agents\n'));
        console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

        for (const agent of agents) {
            console.log(`\n${chalk.cyan(agent.name)}`);
            console.log(`  Account: ${chalk.gray(agent.accountId)}`);
            console.log(`  Machine: ${chalk.gray(agent.machineId || 'Unknown')}`);
            console.log(`  Created: ${chalk.gray(new Date(agent.created).toLocaleDateString())}`);

            if (agent.lastSeen) {
                const lastSeenDate = new Date(agent.lastSeen);
                const hoursAgo = Math.floor((Date.now() - lastSeenDate) / (1000 * 60 * 60));
                console.log(`  Last Active: ${chalk.gray(hoursAgo + ' hours ago')}`);
            }

            if (agent.stats) {
                console.log(`  Jobs Completed: ${chalk.green(agent.stats.jobsCompleted || 0)}`);
                console.log(`  Total Earned: ${chalk.green((agent.stats.totalEarned || 0) + ' ℏ')}`);
            }
        }

        console.log(chalk.gray('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(`Total Agents: ${chalk.cyan(agents.length)}\n`);

    } catch (error) {
        console.error(chalk.red('Error loading agents:', error.message));
    }
}

async function loadAgents() {
    try {
        const data = await fs.readFile(AGENTS_FILE, 'utf8');
        return JSON.parse(data).agents || [];
    } catch (error) {
        return [];
    }
}

async function saveAgent(agentData) {
    await fs.mkdir(CONFIG_DIR, { recursive: true });

    let data = { agents: [] };
    try {
        const existing = await fs.readFile(AGENTS_FILE, 'utf8');
        data = JSON.parse(existing);
    } catch (e) {
        // File doesn't exist yet
    }

    // Check if agent already exists
    const existingIndex = data.agents.findIndex(a =>
        a.accountId === agentData.accountId ||
        a.machineId === agentData.machineId
    );

    if (existingIndex >= 0) {
        // Update existing agent
        data.agents[existingIndex] = { ...data.agents[existingIndex], ...agentData };
    } else {
        // Add new agent
        data.agents.push(agentData);
    }

    await fs.writeFile(AGENTS_FILE, JSON.stringify(data, null, 2));
}

module.exports = {
    create,
    balance,
    list,
    saveAgent,
};