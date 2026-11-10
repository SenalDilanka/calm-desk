'use strict';

const { start } = require('./app.js');

start().catch((err) => {
  console.error('Calm Desk failed to start:', err);
  process.exit(1);
});
