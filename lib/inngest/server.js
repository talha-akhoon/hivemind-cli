const express = require('express');
const { serve } = require('inngest/express');
const { inngest } = require('./client');
const chalk = require('chalk');
require('dotenv').config();

// Import all workflow functions
const {
  scanMarketplaceFunction,
  evaluateBountyFunction,
  executeTrainingFunction,
  submitResultsFunction,
  monitorAgentFunction
} = require('./functions');

const app = express();
app.use(express.json());
const port = process.env.INNGEST_PORT || 3003;

// Set up Inngest handler
app.use('/api/inngest', serve({
  client: inngest,
  functions: [
    scanMarketplaceFunction,
    evaluateBountyFunction,
    executeTrainingFunction,
    submitResultsFunction,
    monitorAgentFunction
  ]
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'hivemind-inngest-server' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`🚀 HiveMind Inngest server running on port ${port}`);
    console.log(`📊 Dashboard: http://localhost:${port}/api/inngest`);
  });
}

module.exports = app;
