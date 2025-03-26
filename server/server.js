const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const app = express();

// Environment variables
const ES_HOST = process.env.ES_HOST || 'https://25d8fd86a59644df8704717a4be06839.us-east-1.aws.found.io:443';
const ES_INDEX = process.env.ES_INDEX || 'products';
const ES_USERNAME = process.env.ES_USERNAME || 'elastic';
const ES_PASSWORD = process.env.ES_PASSWORD || '8s3HPupgMRz2EfAjvHOCNQDW';

// Enable CORS for all routes with a more permissive configuration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, baggage, sentry-trace, x-forwarded-for');
  res.header('Access-Control-Allow-Credentials', true);
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Request body parsing
app.use(express.json({ limit: '1mb' }));

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use('/api/elastic-search', limiter);

// Request validation middleware
const validateSearchRequest = (req, res, next) => {
  if (!req.body || Object.keys(req.body).length > 100) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  next();
};

// Elasticsearch proxy endpoint
app.post('/api/elastic-search', validateSearchRequest, async (req, res) => {
  try {
    console.log('Received search request:', JSON.stringify(req.body));
   
    const response = await axios.post(
      `${ES_HOST}/${ES_INDEX}/_search`,
      req.body,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${ES_USERNAME}:${ES_PASSWORD}`).toString('base64')
        }
      }
    );
   
    console.log('Elasticsearch response status:', response.status);
    res.json(response.data);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
   
    // Send a user-friendly error
    res.status(error.response?.status || 500).json({
      error: 'Search failed',
      message: 'Unable to complete search request. Please try again later.'
    });
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'API is working correctly' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`Access health check at http://localhost:${PORT}/health`);
  console.log(`Elasticsearch proxy endpoint at http://localhost:${PORT}/api/elastic-search`);
  console.log(`CORS headers are fully opened`);
});