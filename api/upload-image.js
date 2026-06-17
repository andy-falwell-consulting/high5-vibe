const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';

let sessionToken = null;

async function getToken(db) {
  if (sessionToken) return sessionToken;
  const res = await fetch(
    `${FMP_HOST}/fmi/data/v2/databases/${encodeURIComponent(db)}/sessions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from('admin:itstime').toString('base64'),
      },
      body: '{}',
    }
  );
  const data = await res.json();
  if (!data.response?.token) throw new Error('FMP auth failed');
  sessionToken = data.response.token;
  return sessionToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { recordId, layout, db } = req.query;
  if (!recordId || !layout || !db) return res.status(400).json({ error: 'Missing params' });

  // Read raw body
  const buf = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const contentType = req.headers['content-type'] || 'image/jpeg';
  const filename = req.headers['x-filename'] || 'image.jpg';

  try {
    const token = await getToken(db);

    const formData = new FormData();
    formData.append('upload', new Blob([buf], { type: contentType }), filename);

    const url = `${FMP_HOST}/fmi/data/v2/databases/${encodeURIComponent(db)}/layouts/${encodeURIComponent(layout)}/records/${recordId}/containers/Picture/1`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (upstream.status === 401) {
      sessionToken = null;
      return res.status(401).json({ error: 'FMP token expired — retry' });
    }

    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: false, sizeLimit: '10mb' } };
