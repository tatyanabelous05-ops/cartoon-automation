const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    openai_key_set: !!process.env.OPENAI_API_KEY,
    higgsfield_key_set: !!process.env.HIGGSFIELD_API_KEY_ID && !!process.env.HIGGSFIELD_API_KEY
  });
});

// Оригінальний ендпоінт — аналіз сценарію через GPT-4o
app.post('/api/analyze', async (req, res) => {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set on server' });
  }

  const { systemPrompt, userText, images } = req.body;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        ...(images || []).map(img => ({
          type: 'image_url',
          image_url: { url: img.data, detail: 'low' }
        }))
      ]
    }
  ];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        max_tokens: 8000,
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'OpenAI API error' });
    }

    const text = data.choices?.[0]?.message?.content || '';
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// НОВИЙ ендпоінт — генерація одного зображення через Higgsfield Seedream
app.post('/api/generate-image', async (req, res) => {
  const KEY_ID = process.env.HIGGSFIELD_API_KEY_ID;
  const KEY_SECRET = process.env.HIGGSFIELD_API_KEY;

  if (!KEY_ID || !KEY_SECRET) {
    return res.status(500).json({ error: 'Higgsfield API keys not set on server' });
  }

  const { prompt, scene_number, aspect_ratio = '16:9' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const credentials = `${KEY_ID}:${KEY_SECRET}`;

  try {
    // Крок 1: відправляємо запит на генерацію
    const submitResp = await fetch('https://platform.higgsfield.ai/bytedance/seedream/v4/text-to-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${credentials}`
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio,
        resolution: '2K'
      })
    });

    const submitData = await submitResp.json();
    if (!submitResp.ok) {
      return res.status(submitResp.status).json({ error: submitData.error || submitData.message || 'Higgsfield submit error' });
    }

    const request_id = submitData.request_id;
    if (!request_id) {
      return res.status(500).json({ error: 'No request_id in response', raw: submitData });
    }

    // Крок 2: поллінг — чекаємо поки картинка готова
    const status_url = `https://platform.higgsfield.ai/requests/${request_id}/status`;
    let imageUrl = null;
    let attempts = 0;
    const maxAttempts = 60; // максимум 2 хвилини (60 * 2с)

    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;

      const statusResp = await fetch(status_url, {
        headers: { 'Authorization': `Key ${credentials}` }
      });
      const statusData = await statusResp.json();

      if (statusData.status === 'completed') {
        imageUrl = statusData.images?.[0]?.url || statusData.images?.[0];
        break;
      } else if (statusData.status === 'failed' || statusData.status === 'nsfw') {
        return res.status(500).json({ error: `Generation ${statusData.status}` });
      }
      // queued або in_progress — продовжуємо чекати
    }

    if (!imageUrl) {
      return res.status(408).json({ error: 'Generation timed out after 2 minutes' });
    }

    res.json({ scene_number, image_url: imageUrl, request_id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cartoon Pipeline AUTO running on port ${PORT}`);
  console.log(`OPENAI_API_KEY set: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`HIGGSFIELD keys set: ${!!process.env.HIGGSFIELD_API_KEY_ID && !!process.env.HIGGSFIELD_API_KEY}`);
});
