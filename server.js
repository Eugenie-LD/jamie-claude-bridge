const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DB_FILE = path.join(__dirname, 'meetings_history.json');

// Config email Zoho
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.eu',
  port: 465,
  secure: true,
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

Eugénie pilote : campagnes de dons, CRM (ActiveCampaign, Mindbaz), acquisition payante, 
landing pages, SEO, coordination inter-équipes (Aurélien SEA, Floriane com, Atifa/Wahiba CM, 
Edouard vidéo, FunnelLab dev, Tarek/Fanny direction).
Objectif permanent : augmenter l'AOV et le ROI des campagnes.
Les donateurs sont appelés "LifeChangers".
`;

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📩 Meeting reçu de Jamie:', JSON.stringify(payload).slice(0, 200));

    const meetingData = {
      title: payload.title || payload.meeting_title || payload.name || 'Meeting sans titre',
      date: payload.date || payload.created_at || new Date().toISOString(),
      transcript: payload.transcript || payload.transcription || payload.content || '',
      summary: payload.summary || payload.ai_summary || '',
      attendees: payload.attendees || payload.participants || [],
      duration: payload.duration || '',
    };

    const history = loadHistory();
    const recentMeetings = history.slice(-5).map(m => 
      `[${m.date?.slice(0,10)}] ${m.title}: ${m.summary?.slice(0,300) || 'pas de résumé'}`
    ).join('\n');

    saveToHistory(meetingData);

    const prompt = `
${LIFE_CONTEXT}

## Contexte des 5 derniers meetings
${recentMeetings || 'Aucun historique encore.'}

---

## Nouveau meeting à analyser
**Titre :** ${meetingData.title}
**Date :** ${meetingData.date}
**Participants :** ${Array.isArray(meetingData.attendees) ? meetingData.attendees.join(', ') : meetingData.attendees}
**Durée :** ${meetingData.duration}

**Résumé Jamie :**
${meetingData.summary}

**Transcript :**
${meetingData.transcript?.slice(0, 8000) || 'Non disponible'}

---

## Analyse demandée

Produis une synthèse structurée en français avec :

### 🎯 Points clés (5 max)
Les informations essentielles à retenir.

### ✅ Décisions prises
Ce qui a été acté. Si rien, écris "Aucune décision formelle".

### 🚀 Next steps & actions
Format : **[Responsable]** — Action — Deadline si mentionnée

### 🔗 Liens avec les projets LIFE en cours
Connexions pertinentes avec les campagnes, outils ou équipes connus.

### 📋 Format Notion/Asana
Un bloc prêt à copier-coller pour créer une tâche ou une note de projet.
`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const analysis = message.content[0].text;
    console.log('✅ Analyse générée avec succès');

    // Formatage HTML de l'analyse pour l'email
    const analysisHtml = analysis
      .replace(/### (.*)/g, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    const dateFormatted = new Date(meetingData.date).toLocaleDateString('fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    // Envoi de l'email
    await transporter.sendMail({
      from: `"Jamie × Claude" <${process.env.ZOHO_EMAIL}>`,
      to: process.env.RECIPIENT_EMAIL,
      subject: `📋 Analyse meeting : ${meetingData.title} — ${dateFormatted}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333;">
          <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
            <h2 style="color: white; margin: 0;">📋 Analyse de meeting</h2>
            <p style="color: #aaa; margin: 8px 0 0;">${meetingData.title} · ${dateFormatted}</p>
          </div>
          <div style="background: #f9f9f9; padding: 8px 24px; border-left: 4px solid #e0e0e0;">
            <p style="margin: 8px 0; font-size: 13px; color: #666;">
              👥 ${Array.isArray(meetingData.attendees) ? meetingData.attendees.join(', ') : (meetingData.attendees || 'Non renseigné')}
              &nbsp;·&nbsp; ⏱️ ${meetingData.duration || 'Durée non renseignée'}
              &nbsp;·&nbsp; 🗂️ Meeting #${loadHistory().length} en base
            </p>
          </div>
          <div style="background: white; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
            ${analysisHtml}
          </div>
          <p style="text-align: center; font-size: 11px; color: #bbb; margin-top: 16px;">
            Généré automatiquement par Jamie × Claude Bridge · LIFE
          </p>
        </div>
      `,
    });

    console.log('📧 Email envoyé à', process.env.RECIPIENT_EMAIL);

    res.json({
      success: true,
      meeting_title: meetingData.title,
      analysis: analysis,
      email_sent: true,
      meetings_in_history: loadHistory().length
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/history', (req, res) => {
  const history = loadHistory();
  res.json({ 
    total: history.length, 
    meetings: history.map(m => ({ title: m.title, date: m.date, saved_at: m.saved_at }))
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'Jamie-Claude Bridge opérationnel ✅', meetings_stored: loadHistory().length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur port ${PORT}`));
