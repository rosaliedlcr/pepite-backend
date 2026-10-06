require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB max per photo
});

// --- Config (set these as environment variables on Render, never commit real values) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠️  Variables d\'environnement manquantes — vérifie SUPABASE_URL et SUPABASE_SERVICE_KEY.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Local image embedding model (runs inside this server, no external API call) ---
// Loaded once, lazily, on the first request — the first call after a cold start
// will be slower (downloading + loading the model), subsequent calls are fast.
let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', { dtype: 'q8' })
    );
  }
  return embedderPromise;
}

async function getEmbedding(buffer) {
  const embedder = await getEmbedder();
  const tmpPath = path.join(os.tmpdir(), `img-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const output = await embedder(tmpPath);
    const embedding = Array.from(output.data);
    if (!embedding.length || typeof embedding[0] !== 'number') {
      throw new Error('Le modèle local n\'a pas renvoyé un vecteur valide.');
    }
    return embedding;
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// --- Add a real item to the catalog ---
app.post('/api/items', upload.single('image'), async (req, res) => {
  try {
    const { name, shop, address, size, price, category, sellerType, shipsPackages } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Photo manquante.' });
    if (!shop || !price) return res.status(400).json({ error: 'Friperie et prix sont requis.' });

    const embedding = await getEmbedding(req.file.buffer);

    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from('items')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype || 'image/jpeg' });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('items').getPublicUrl(fileName);

    const { data, error } = await supabase
      .from('items')
      .insert({
        name: name || null,
        shop,
        address: address || null,
        size: size || null,
        price,
        category: category || null,
        seller_type: sellerType || 'particulier',
        ships_packages: shipsPackages === 'true',
        image_url: urlData.publicUrl,
        embedding,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, item: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Search for visually similar items ---
app.post('/api/search', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Photo manquante.' });

    const embedding = await getEmbedding(req.file.buffer);

    const { data, error } = await supabase.rpc('match_items', {
      query_embedding: embedding,
      match_count: 8,
    });
    if (error) throw error;

    res.json({ ok: true, results: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- List recent items (used for the "live list" view) ---
app.get('/api/items', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('items')
      .select('id, name, shop, address, size, price, category, image_url, seller_type, ships_packages, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ ok: true, items: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Bulk import agent ---
// Protected by a secret key so it can't be triggered by random visitors.
// Set IMPORT_SECRET as an environment variable on Render, then send it
// as the "x-import-key" header when calling this endpoint.
const IMPORT_SECRET = process.env.IMPORT_SECRET;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const splitLine = (line) => {
    const out = []; let cur = ''; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const headers = splitLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!IMPORT_SECRET || req.headers['x-import-key'] !== IMPORT_SECRET) {
      return res.status(401).json({ error: 'Clé d\'import manquante ou invalide.' });
    }

    let rows = [];
    if (req.file) {
      rows = parseCsv(req.file.buffer.toString('utf-8'));
    } else if (Array.isArray(req.body.items)) {
      rows = req.body.items;
    } else {
      return res.status(400).json({ error: 'Envoie soit un fichier CSV (champ "file"), soit un JSON { items: [...] }.' });
    }

    const results = { success: 0, failed: [] };

    for (const row of rows) {
      try {
        if (!row.image_url) throw new Error('image_url manquant');
        if (!row.shop || !row.price) throw new Error('shop ou price manquant');

        const imgRes = await fetch(row.image_url);
        if (!imgRes.ok) throw new Error(`photo introuvable (${imgRes.status})`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        const embedding = await getEmbedding(buffer);

        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('items')
          .upload(fileName, buffer, { contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from('items').getPublicUrl(fileName);

        const { error: insertError } = await supabase.from('items').insert({
          name: row.name || null,
          shop: row.shop,
          address: row.address || null,
          size: row.size || null,
          price: row.price,
          category: row.category || null,
          seller_type: row.seller_type || 'friperie',
          ships_packages: row.ships_packages === 'true' || row.ships_packages === true,
          image_url: urlData.publicUrl,
          embedding,
        });
        if (insertError) throw insertError;

        results.success++;
      } catch (e) {
        results.failed.push({ row, error: e.message });
      }
    }

    res.json({ ok: true, ...results, total: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Pépite backend démarré sur le port ${PORT}`));
