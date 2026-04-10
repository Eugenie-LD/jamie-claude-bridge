const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Base de données simple : un fichier JSON qui accumule tous les meetings
const DB_FILE = path.join(__dirname, 'meetings_history.json');

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

// Contexte LIFE injecté automatiquement dans chaque analyse
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

// Endpoint principal appelé par Jamie
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📩 Meeting reçu de Jamie:', JSON.stringify(payload).slice(0, 200));

    // Jamie peut envoyer dans différents formats — on normalise
    const meetingData = {
      title: payload.title || payload.meeting_title || payload.name || 'Meeting sans titre',
      date: payload.date || payload.created_at || new Date().toISOString(),
      transcript: payload.transcript || payload.transcription || payload.content || '',
      summary: payload.summary || payload.ai_summary || '',
      attendees: payload.attendees || payload.participants || [],
      duration: payload.duration || '',
    };

    // On charge les 5 derniers meetings pour donner du contexte à Claude
    const history = loadHistory();
    const recentMeetings = history.slice(-5).map(m => 
      `[${m.date?.slice(0,10)}] ${m.title}: ${m.summary?.slice(0,300) || 'pas de résumé'}`
    ).join('\n');

    // On sauvegarde ce meeting
    saveToHistory(meetingData);

    // Prompt envoyé à Claude
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

    // Réponse retournée à Jamie (et loggée)
    res.json({
      success: true,
      meeting_title: meetingData.title,
      analysis: analysis,
      meetings_in_history: loadHistory().length
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint pour consulter l'historique
app.get('/history', (req, res) => {
  const history = loadHistory();
  res.json({ 
    total: history.length, 
    meetings: history.map(m => ({ title: m.title, date: m.date, saved_at: m.saved_at }))
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Jamie-Claude Bridge opérationnel ✅', meetings_stored: loadHistory().length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur port ${PORT}`));
