const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DB_FILE = path.join(__dirname, 'meetings_history.json');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_PASSWORD,
  },
});

app.use('/webhook', (req, res, next) => {
  const jamieKey = req.headers['x-jamie-api-key'];
  if (jamieKey !== process.env.JAMIE_API_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
});

function loadHistory() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}

function saveToHistory(meeting) {
  const history = loadHistory();
  history.push({ ...meeting, saved_at: new Date().toISOString() });
  fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
  return history;
}

const LIFE_CONTEXT = `
Tu es l'assistant marketing stratégique d'Eugénie, Strategic Marketing Lead chez LIFE, 
une ONG française présente dans 25+ pays avec 4 piliers : 
- OASIS (eau/assainissement)
- 1€=1repas (aide alimentaire, campagne Ramadan)  
- SAPOUSSE (environnement)
- Éducation

Eugénie pilote : campagnes de dons, CRM (ActiveCampaign, Mindbaz), acquisition pay
