const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const DB_FILE = path.join(__dirname, 'meetings_history.json');

// Vérification que la requête vient bien de Jamie
app.use('/webhook', (req, res, next) => {
  const jamieKey = req.headers['x-jamie-api-key'];
  if (jamieKey !== process.env.JAMIE_API_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
});

// Même vérification pour la route manuelle
app.use('/manual', (req, res, next) => {
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

// =============================================================
// Extraire les données du meeting depuis le payload Jamie
// Jamie envoie : { metadata: {...}, data: { title, startTime, 
//   endTime, summary: { markdown, short }, transcript, ... } }
// =============================================================
function extractMeetingData(payload) {
  // Jamie wraps everything in payload.data
  const d = payload.data || payload;

  // Titre
  const title = d.title || d.meeting_title || d.name || 'Meeting sans titre';

  // Date : Jamie envoie startTime / endTime
  const date = d.startTime || d.date || d.created_at || new Date().toISOString();
  const endTime = d.endTime || '';

  // Durée : calculer à partir de startTime/endTime si possible
  let duration = d.duration || '';
  if (!duration && d.startTime && d.endTime) {
    const diffMs = new Date(d.endTime) - new Date(d.startTime);
    const diffMin = Math.round(diffMs / 60000);
    duration = `${diffMin} min`;
  }

  // Transcript : Jamie envoie une string formatée
  const transcript = d.transcript || d.transcription || d.content || '';

  // Summary : Jamie envoie un objet { markdown, html, short }
  let summary = '';
  if (typeof d.summary === 'object' && d.summary !== null) {
    summary = d.summary.markdown || d.summary.short || d.summary.html || '';
  } else {
    summary = d.summary || d.ai_summary || '';
  }

  // Participants
  const attendees = d.attendees || d.participants || [];

  return { title, date, endTime, duration, transcript, summary, attendees };
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

// Fonction qui traite le meeting (analyse Claude + email)
async function processMeeting(payload) {
  try {
    const meetingData = extractMeetingData(payload);

    // Log pour debug
    console.log('📝 Meeting extrait:', {
      title: meetingData.title,
      duration: meetingData.duration,
      summaryLength: meetingData.summary.length,
      transcriptLength: meetingData.transcript.length,
    });

    const history = loadHistory();
    const recentMeetings = history.slice(-5).map(m =>
      `[${m.date?.slice(0, 10)}] ${m.title}: ${(m.summary || '').slice(0, 300) || 'pas de résumé'}`
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
${meetingData.summary.slice(0, 6000) || 'Non disponible'}

**Transcript :**
${meetingData.transcript.slice(0, 8000) || 'Non disponible'}

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
    console.log('✅ Analyse générée avec succès pour:', meetingData.title);

    // Envoi email
    await sendEmail(meetingData, analysis);

    return { success: true, meeting_title: meetingData.title, analysis };
  } catch (error) {
    console.error('❌ Erreur traitement meeting:', error.message);
    return { success: false, error: error.message };
  }
}

// Fonction email via Resend
async function sendEmail(meetingData, analysis) {
  try {
    const analysisHtml = analysis
      .replace(/### (.*)/g, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    const dateFormatted = new Date(meetingData.date).toLocaleDateString('fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    await resend.emails.send({
      from: 'Jamie × Claude <onboarding@resend.dev>',
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
    console.log('📧 Email envoyé via Resend à', process.env.RECIPIENT_EMAIL);
  } catch (err) {
    console.error('❌ Erreur email Resend:', err.message);
  }
}

// ============================================================
// WEBHOOK JAMIE — avec délai de 10 min pour laisser le temps
// à Jamie de finaliser la transcription
// ============================================================
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const meetingTitle = payload?.data?.title || payload?.title || 'sans titre';
    console.log('📩 Webhook reçu de Jamie:', meetingTitle);
    console.log('📦 Payload keys:', Object.keys(payload));
    if (payload.data) {
      console.log('📦 Data keys:', Object.keys(payload.data));
      console.log('📦 Summary type:', typeof payload.data.summary);
      console.log('📦 Transcript length:', (payload.data.transcript || '').length);
    }

    // Répondre immédiatement à Jamie pour éviter un timeout
    res.json({ success: true, message: 'Reçu ! Traitement dans 10 minutes.' });

    // Attendre 10 minutes que Jamie finalise la transcription
    const DELAY_MINUTES = 10;
    console.log(`⏳ Attente de ${DELAY_MINUTES} min avant traitement...`);
    await new Promise(resolve => setTimeout(resolve, DELAY_MINUTES * 60 * 1000));

    console.log('🔄 Délai écoulé, lancement de l\'analyse...');
    const result = await processMeeting(payload);
    console.log('📊 Résultat:', result.success ? '✅ OK' : '❌ Erreur');

  } catch (error) {
    console.error('❌ Erreur webhook:', error.message);
  }
});

// ============================================================
// ROUTE MANUELLE — pour relancer un meeting sans délai
// Accepte soit le format Jamie brut, soit un format simplifié
// ============================================================
app.post('/manual', async (req, res) => {
  try {
    const payload = req.body;
    const meetingTitle = payload?.data?.title || payload?.title || 'sans titre';
    console.log('🔧 Traitement manuel lancé pour:', meetingTitle);

    const result = await processMeeting(payload);
    res.json(result);
  } catch (error) {
    console.error('❌ Erreur manuelle:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ROUTES UTILITAIRES
// ============================================================
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
