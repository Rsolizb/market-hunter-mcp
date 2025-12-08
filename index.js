// index.js
// Komerzia Market Hunter MCP - Railway
// Busca negocios en Google Maps y devuelve leads enriquecidos con teléfono y web.

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Pequeño helper para dormir (útil para respetar rate limits de Google)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Llama a Google Places Text Search para una categoría + ciudad + país
 */
async function searchPlacesByCategory({ category, city, country, apiKey }) {
  const query = encodeURIComponent(`${category} en ${city}, ${country}`);
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;

  const places = [];
  let safetyCounter = 0;
  let nextPageToken = null;

  do {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("Error en Text Search:", data.status, data.error_message);
      break;
    }

    if (Array.isArray(data.results)) {
      places.push(...data.results);
    }

    nextPageToken = data.next_page_token || null;

    // Google pide esperar un ratito para next_page_token
    if (nextPageToken) {
      await sleep(2000);
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${nextPageToken}&key=${apiKey}`;
    }

    safetyCounter += 1;
  } while (nextPageToken && safetyCounter < 3); // máximo 3 páginas por categoría

  return places;
}

/**
 * Llama a Place Details para obtener teléfono y website
 */
async function enrichLeadWithDetails(place, apiKey) {
  const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,international_phone_number,website&key=${apiKey}`;

  try {
    const resp = await fetch(detailsUrl);
    const json = await resp.json();

    if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      console.warn("Error en Place Details:", json.status, json.error_message);
    }

    const details = json.result || {};

    const phone =
      details.formatted_phone_number ||
      details.international_phone_number ||
      null;

    const website = details.website || null;

    return {
      name: place.name || null,
      address: place.formatted_address || null,
      rating: typeof place.rating === "number" ? place.rating : null,
      location: place.geometry?.location || null,
      place_id: place.place_id,
      phone,
      website,
    };
  } catch (err) {
    console.error("Error llamando a Place Details:", err.message);
    return {
      name: place.name || null,
      address: place.formatted_address || null,
      rating: typeof place.rating === "number" ? place.rating : null,
      location: place.geometry?.location || null,
      place_id: place.place_id,
      phone: null,
      website: null,
    };
  }
}

/**
 * Endpoint principal: ejecuta la campaña
 */
app.post("/run-campaign", async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      campaignId,
      campaignName,
      categories = [],
      city,
      country,
    } = req.body || {};

    if (!campaignId || !city || !country || !categories.length) {
      return res.status(400).json({
        error: "Parámetros inválidos",
        details:
          "Se requieren campaignId, city, country y al menos una categoría.",
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Falta GOOGLE_MAPS_API_KEY",
        details:
          "Configura la variable de entorno GOOGLE_MAPS_API_KEY en Railway.",
      });
    }

    // 1) Buscar lugares por categoría
    const allPlacesMap = new Map(); // place_id -> place

    for (const rawCategory of categories) {
      const category = String(rawCategory || "").trim();
      if (!category) continue;

      const places = await searchPlacesByCategory({
        category,
        city,
        country,
        apiKey,
      });

      for (const p of places) {
        if (!p.place_id) continue;
        // Evitamos duplicados por place_id
        if (!allPlacesMap.has(p.place_id)) {
          allPlacesMap.set(p.place_id, p);
        }
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());

    // Limitamos para no matar la API (ajusta si quieres más)
    const MAX_LEADS = 50;
    const limitedPlaces = allPlaces.slice(0, MAX_LEADS);

    // 2) Enriquecer cada lugar con teléfono y website
    const leads = [];
    for (const place of limitedPlaces) {
      const lead = await enrichLeadWithDetails(place, apiKey);
      leads.push(lead);
      // Pequeño delay para no saturar Place Details
      await sleep(150);
    }

    // 3) Calcular resumen
    const total = leads.length;
    const ratings = leads
      .map((l) => (typeof l.rating === "number" ? l.rating : null))
      .filter((r) => r !== null);

    const avgRating =
      ratings.length > 0
        ? Number(
            (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)
          )
        : 0;

    const executionTime = Date.now() - startTime;

    // 4) Respuesta final
    return res.json({
      campaignId,
      campaignName,
      categories,
      city,
      country,
      leads,
      executionTime,
      summary: {
        total,
        avgRating,
      },
    });
  } catch (err) {
    console.error("Error en /run-campaign:", err);

    return res.status(500).json({
      error: "Error ejecutando campaña",
      details: err.message || "Error desconocido",
    });
  }
});

// Health check simple
app.get("/", (_req, res) => {
  res.send("Komerzia Market Hunter MCP is running.");
});

app.listen(PORT, () => {
  console.log(`Market Hunter MCP listening on port ${PORT}`);
});
