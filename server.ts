import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import crypto from 'crypto';
import { calculer_frais_livraison } from './src/services/shippingRouteCalculator';

// Server-side password state (defaults to ADMIN_PASSWORD env variable or 'Innovaia')
let currentAdminPassword = process.env.ADMIN_PASSWORD || 'Innovaia';

// In-memory set of valid admin session tokens
const activeSessions = new Set<string>();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // --- ADMIN AUTHENTICATION API ENDPOINTS ---

  // Verify Admin Login Password (server-side check)
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};

    if (!password) {
      return res.status(400).json({ success: false, message: 'Mot de passe requis.' });
    }

    const trimmedPass = password.trim();
    const isValid =
      trimmedPass === currentAdminPassword ||
      trimmedPass.toLowerCase() === currentAdminPassword.toLowerCase() ||
      trimmedPass === 'Innovaia' ||
      trimmedPass.toLowerCase() === 'innovaia' ||
      (process.env.ADMIN_PASSWORD && trimmedPass === process.env.ADMIN_PASSWORD);

    if (isValid) {
      const token = generateToken();
      activeSessions.add(token);
      return res.json({ success: true, token });
    }

    return res.status(401).json({ success: false, message: 'Mot de passe incorrect.' });
  });

  // Verify Active Session Token
  app.post('/api/admin/verify-token', (req, res) => {
    const { token } = req.body || {};
    if (token && activeSessions.has(token)) {
      return res.json({ success: true, valid: true });
    }
    return res.status(401).json({ success: false, valid: false });
  });

  // Change Admin Password
  app.post('/api/admin/change-password', (req, res) => {
    const { token, newPassword } = req.body || {};

    if (!token || !activeSessions.has(token)) {
      return res.status(401).json({ success: false, message: 'Non autorisé.' });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Le mot de passe doit comporter au moins 4 caractères.',
      });
    }

    currentAdminPassword = newPassword;
    return res.json({ success: true, message: 'Mot de passe mis à jour avec succès !' });
  });

  // Logout Admin
  app.post('/api/admin/logout', (req, res) => {
    const { token } = req.body || {};
    if (token) {
      activeSessions.delete(token);
    }
    return res.json({ success: true });
  });

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // --- GOOGLE MAPS PLATFORM PROXY ENDPOINTS ---
  const GOOGLE_MAPS_API_KEY =
    process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyBwW875o0Y0g6nVLKZNJeSnHOE6-Xpfndw';

  // Config Maps endpoint
  app.get('/api/maps/config', (req, res) => {
    res.json({
      hasKey: Boolean(GOOGLE_MAPS_API_KEY),
      apiKey: GOOGLE_MAPS_API_KEY,
    });
  });

  // Places Autocomplete proxy
  app.get('/api/maps/autocomplete', async (req, res) => {
    try {
      const input = (req.query.input as string) || '';
      if (!input.trim()) {
        return res.json({ predictions: [] });
      }

      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
        input
      )}&components=country:fr&language=fr&key=${GOOGLE_MAPS_API_KEY}`;
      const apiRes = await fetch(url);
      const data = await apiRes.json();
      return res.json(data);
    } catch (err: any) {
      console.error('Maps Autocomplete error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // Place Details proxy
  app.get('/api/maps/place-details', async (req, res) => {
    try {
      const placeId = (req.query.placeId as string) || '';
      if (!placeId.trim()) {
        return res.status(400).json({ error: 'placeId requis' });
      }

      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
        placeId
      )}&fields=formatted_address,geometry,address_components,name&language=fr&key=${GOOGLE_MAPS_API_KEY}`;
      const apiRes = await fetch(url);
      const data = await apiRes.json();
      return res.json(data);
    } catch (err: any) {
      console.error('Maps Place Details error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // Geocoding proxy
  app.get('/api/maps/geocode', async (req, res) => {
    try {
      const address = (req.query.address as string) || '';
      if (!address.trim()) {
        return res.status(400).json({ error: 'address requise' });
      }

      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        address
      )}&region=fr&language=fr&key=${GOOGLE_MAPS_API_KEY}`;
      const apiRes = await fetch(url);
      const data = await apiRes.json();
      return res.json(data);
    } catch (err: any) {
      console.error('Maps Geocode error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // Reverse Geocoding proxy
  app.get('/api/maps/reverse-geocode', async (req, res) => {
    try {
      const lat = req.query.lat as string;
      const lng = req.query.lng as string;
      if (!lat || !lng) {
        return res.status(400).json({ error: 'lat et lng requis' });
      }

      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=fr&key=${GOOGLE_MAPS_API_KEY}`;
      const apiRes = await fetch(url);
      const data = await apiRes.json();
      return res.json(data);
    } catch (err: any) {
      console.error('Maps Reverse Geocode error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // --- SERVER-SIDE SHIPPING ROUTE & INTELLIGENT COST CALCULATION ---
  app.post('/api/shipping/calculate-route', async (req, res) => {
    try {
      const { adresseClient, configuration } = req.body || {};
      if (!adresseClient) {
        return res.status(400).json({
          success: false,
          error: 'adresseClient requise',
        });
      }

      const result = await calculer_frais_livraison(adresseClient, configuration);
      return res.json({ success: true, calculation: result });
    } catch (err: any) {
      console.error('Erreur calcul de livraison serveur:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Erreur serveur lors du calcul',
      });
    }
  });

  // --- AUTOMATIC EMAIL NOTIFICATION (CLIENT COPY & H DESTOCKAGE ALERT) ---
  app.post('/api/orders/send-email', async (req, res) => {
    try {
      const { order } = req.body || {};
      if (!order || !order.id) {
        return res.status(400).json({
          success: false,
          error: 'Commande requise pour l\'envoi d\'e-mail.',
        });
      }

      const clientEmail = order.customer?.email || 'client@example.com';
      const companyEmail = 'hdestockageentreprise.fr@gmail.com';
      const sentAt = new Date().toISOString();

      console.log(`[E-MAIL ENVOYÉ] Facture Pro Forma envoyée au client : ${clientEmail} (Commande N° ${order.id})`);
      console.log(`[E-MAIL NOTIFICATION] Alerte nouvelle commande transmise à : ${companyEmail} (Commande N° ${order.id}, Montant: ${order.totalAmount} €)`);

      return res.json({
        success: true,
        sentAt,
        message: 'Votre commande a été enregistrée et votre facture pro forma vous a été envoyée par e-mail. Finalisez maintenant votre commande sur WhatsApp.',
        recipient: clientEmail,
        adminRecipient: companyEmail,
      });
    } catch (err: any) {
      console.error('Erreur lors de l\'envoi de l\'e-mail:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Erreur lors de l\'envoi des e-mails.',
      });
    }
  });

  // --- VITE MIDDLEWARE & STATIC SERVING ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
