require('dotenv').config();

const { Inngest } = require('inngest');
const { Agent } = require('@inngest/agent-kit');

// Initialize Inngest client
const inngest = new Inngest({
  id: 'hivemind-agent',
  name: 'HiveMind Protocol Agent',
  env: process.env.NODE_ENV || 'production',
  secret: process.env.INNGEST_SECRET || 'secret',
  apiKey: process.env.INNGEST_API_KEY || 'secret',
  eventKey: process.env.INNGEST_EVENT_KEY || 'secret',
});

// Initialize AgentKit for enhanced agent capabilities
const agentKit = new Agent({
  name: 'hivemind-training-agent',
  description: 'Decentralized AI training marketplace agent',
  version: '0.1.2'
});

module.exports = { inngest, agentKit };
