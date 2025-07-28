#!/usr/bin/env node

'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { version } = require('../package.json');
const { init, start, status, stop } = require('../lib/commands/index');

const program = new Command();

console.log(chalk.cyan(`
 __    __  __                       __       __  __                  __ 
|  \\  |  \\|  \\                     |  \\     /  \\|  \\                |  \\
| $$  | $$ \\$$ __     __   ______  | $$\\   /  $$ \\$$ _______    ____| $$
| $$__| $$|  \\|  \\   /  \\ /      \\ | $$$\\ /  $$$|  \\|       \\  /      $$
| $$    $$| $$ \\$$\\ /  $$|  $$$$$$\\| $$$$\\  $$$$| $$| $$$$$$$\\|  $$$$$$$
| $$$$$$$$| $$  \\$$\\  $$ | $$    $$| $$\\$$ $$ $$| $$| $$  | $$| $$  | $$
| $$  | $$| $$   \\$$ $$  | $$$$$$$$| $$ \\$$$| $$| $$| $$  | $$| $$__| $$
| $$  | $$| $$    \\$$$    \\$$     \\| $$  \\$ | $$| $$| $$  | $$ \\$$    $$
 \\$$   \\$$ \\$$     \\$      \\$$$$$$$ \\$$      \\$$ \\$$ \\$$   \\$$  \\$$$$$$$

Decentralized AI Training Protocol v${version}
`));

program
    .name('hivemind')
    .description('CLI for HiveMind Protocol')
    .version(version);

program
    .command('init')
    .description('Initialize HiveMind agent on this machine')
    .action(init);

program
    .command('start')
    .description('Start the HiveMind agent')
    .option('-d, --daemon', 'Run in background', false)
    .action(start);

program
    .command('status')
    .description('Check agent status')
    .action(status);

program
    .command('stop')
    .description('Stop the HiveMind agent')
    .action(stop);

program
    .command('account')
    .description('Manage Hedera accounts')
    .addCommand(
        new Command('create')
            .description('Create a new Hedera account')
            .action(require('../lib/commands/account').create)
    )
    .addCommand(
        new Command('balance')
            .description('Check account balance')
            .action(require('../lib/commands/account').balance)
    )
    .addCommand(
        new Command('list')
            .description('List configured Hedera accounts')
            .action(require('../lib/commands/account').list)
    )

program.parse(process.argv);