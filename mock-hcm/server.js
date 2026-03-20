// HCM mock server — see Prompt 4.
const express = require('express');
const app = express();
app.use(express.json());

// Seed data — reset via POST /hcm/admin/reset
let balances = {
  'emp001:loc001': 15,
  'emp002:loc001': 10,
  'emp099:loc099': 12,
};

let failureRate = parseFloat(process.env.MOCK_FAILURE_RATE ?? '0');

// Admin: reset seed data and failure rate
app.post('/hcm/admin/reset', (req, res) => {
  balances = {
    'emp001:loc001': 15,
    'emp002:loc001': 10,
    'emp099:loc099': 12,
  };
  failureRate = 0;
  res.json({ ok: true });
});

// Admin: set failure rate
app.post('/hcm/admin/set-failure-rate', (req, res) => {
  failureRate = parseFloat(req.body.rate ?? '0');
  res.json({ ok: true, failureRate });
});

// GET balance
app.get('/hcm/balances/:employeeId/:locationId', (req, res) => {
  console.log(`[HCM MOCK] GET /hcm/balances/${req.params.employeeId}/${req.params.locationId} — status pending`);

  if (Math.random() < failureRate) {
    console.log(`[HCM MOCK] GET /hcm/balances/${req.params.employeeId}/${req.params.locationId} — status 503`);
    return res.status(503).json({ error: 'HCM unavailable (simulated)' });
  }

  const key = `${req.params.employeeId}:${req.params.locationId}`;
  if (!(key in balances)) {
    console.log(`[HCM MOCK] GET /hcm/balances/${req.params.employeeId}/${req.params.locationId} — status 404`);
    return res.status(404).json({ error: 'Employee/location not found' });
  }

  console.log(`[HCM MOCK] GET /hcm/balances/${req.params.employeeId}/${req.params.locationId} — status 200`);
  res.json({
    employeeId: req.params.employeeId,
    locationId: req.params.locationId,
    availableDays: balances[key],
  });
});

// POST request
app.post('/hcm/requests', (req, res) => {
  console.log(`[HCM MOCK] POST /hcm/requests — status pending`);

  if (Math.random() < failureRate) {
    console.log(`[HCM MOCK] POST /hcm/requests — status 503`);
    return res.status(503).json({ error: 'HCM unavailable (simulated)' });
  }

  const { employeeId, locationId, daysRequested } = req.body;
  const key = `${employeeId}:${locationId}`;

  if (!(key in balances)) {
    console.log(`[HCM MOCK] POST /hcm/requests — status 404`);
    return res.status(404).json({ error: 'Employee/location not found' });
  }

  if (balances[key] < daysRequested) {
    console.log(`[HCM MOCK] POST /hcm/requests — status 422`);
    return res.status(422).json({
      error: 'Insufficient balance',
      availableDays: balances[key],
    });
  }

  balances[key] -= daysRequested;
  const transactionId = `hcm-txn-${Date.now()}`;
  console.log(`[HCM MOCK] POST /hcm/requests — status 200`);
  res.json({ transactionId, approved: true });
});

const PORT = process.env.HCM_MOCK_PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`[HCM MOCK] Running on port ${PORT}`);
});

module.exports = app;
