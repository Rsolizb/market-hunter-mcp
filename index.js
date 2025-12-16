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

// Helper para esperar (útil para los next_page_token y para no matar Place Details)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mapa simple de códigos de país para normalizar teléfonos
 * (agrega más países según vayas usando).
 */
const COUNTRY_DIAL_CODES = {
  Bolivia: "+591",
  "Estado Plurinacional de Bolivia": "+591",
  Paraguay: "+595",
  España: "+34",
  Mexico: "+52",
  México: "+52",
  Argentina: "+54",
  Chile: "+56",
  Peru: "+51",
  Perú: "+51",
};

/**
 * Normaliza el teléfono para que, siempre que se pueda,
 * quede con código de país, por ejemplo: +595 123 456 789
 */
function normalizePhone(phone, country) {
  if (!phone || typeof phone !== "string") return null;

  const trimmed = phone.trim();

  // Si ya trae +, lo dejamos tal cual.
  if (trimmed.startsWith("+")) return trimmed;

  const dialCode = COUNTRY_DIAL_CODES[country] || null;
  if (!dialCode) {
    // No tenemos el país mapeado, devolvemos el original.
    return trimmed;
  }

  // Quitamos espacios raros al inicio
  let clean = trimmed.replace(/^\(0\)/, "").trim();

  // Si empieza con 0, lo quitamos para pegar el código de país
  clean = clean.replace(/^0+/, "").trim();

  // Construimos: +CODIGO ESPACIO NÚMERO
  return `${dialCode} ${clean}`;
}

/**
 * Llama a Google Places Text Search para una categoría + ciudad/país,
 * opcionalmente sesgado por centro y radio (lat/lng/radius).
 *
 * NO filtramos resultados extra aquí para no perder leads.
 */
async function searchPlacesByCategory({
  category,
  city,
  country,
  apiKey,
  centerLat,
  centerLng,
  radiusMeters,
}) {
  const query = encodeURIComponent(`${category} en ${city}, ${country}`);

  // Base URL de Text Search
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;

  // Si tenemos coordenadas y radio, los usamos para sesgar la búsqueda
  if (
    typeof centerLat === "number" &&
    !Number.isNaN(centerLat) &&
    typeof centerLng === "number" &&
    !Number.isNaN(centerLng) &&
    typeof radiusMeters === "number" &&
    !Number.isNaN(radiusMeters)
  ) {
    url += `&location=${centerLat},${centerLng}&radius=${radiusMeters}`;
  }

  const places = [];
  let nextPageToken = null;
  let safetyCounter = 0;

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

    if (nextPageToken) {
      // Google pide esperar un ratito antes de usar next_page_token
      await sleep(2000);
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${nextPageToken}&key=${apiKey}`;
    }

    safetyCounter += 1;
  } while (nextPageToken && safetyCounter < 3); // máximo 3 páginas

  return places;
}

/**
 * Llama a Place Details para obtener teléfono y website
 */
async function enrichLeadWithDetails(place, apiKey, country) {
  const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,international_phone_number,website&key=${apiKey}`;

  try {
    const resp = await fetch(detailsUrl);
    const json = await resp.json();

    if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      console.warn("Error en Place Details:", json.status, json.error_message);
    }

    const details = json.result || {};

    const rawPhone =
      details.international_phone_number ||
      details.formatted_phone_number ||
      null;

    const phone = normalizePhone(rawPhone, country);
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
 *
 * Espera un body como:
 * {
 *   "campaignId": "uuid",
 *   "campaignName": "Nombre",
 *   "categories": ["barberías", "spas"],
 *   "city": "Asunción",
 *   "country": "Paraguay",
 *   "centerLat": -25.2637,
 *   "centerLng": -57.5759,
 *   "radiusMeters": 6000
 * }
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
      centerLat,
      centerLng,
      radiusMeters,
    } = req.body || {};

    // Validaciones básicas
    if (!campaignId || !city || !country) {
      return res.status(400).json({
        error: "Parámetros inválidos",
        details:
          "Se requieren campaignId, city y country como mínimo para ejecutar la campaña.",
      });
    }

    let categoriesArray = [];
    if (Array.isArray(categories)) {
      categoriesArray = categories;
    } else if (typeof categories === "string" && categories.trim()) {
      // Por si algún día viene como string simple
      categoriesArray = [categories];
    }

    if (!categoriesArray.length) {
      return res.status(400).json({
        error: "Parámetros inválidos",
        details: "Debes enviar al menos una categoría en 'categories'.",
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

    // 1) Buscar lugares por todas las categorías
    const allPlacesMap = new Map(); // place_id -> place

    for (const rawCategory of categoriesArray) {
      const catStr = String(rawCategory || "").trim();
      if (!catStr) continue;

      const rawPlaces = await searchPlacesByCategory({
        category: catStr,
        city,
        country,
        apiKey,
        centerLat:
          typeof centerLat === "number" && !Number.isNaN(centerLat)
            ? centerLat
            : undefined,
        centerLng:
          typeof centerLng === "number" && !Number.isNaN(centerLng)
            ? centerLng
            : undefined,
        radiusMeters:
          typeof radiusMeters === "number" && !Number.isNaN(radiusMeters)
            ? radiusMeters
            : undefined,
      });

      // 👉 Por ahora NO filtramos por nombre/tipo para no perder leads.
      // Sólo deduplicamos por place_id.
      for (const p of rawPlaces) {
        if (!p.place_id) continue;
        if (!allPlacesMap.has(p.place_id)) {
          allPlacesMap.set(p.place_id, p);
        }
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());

    // Limitamos para no matar la API (ajusta si quieres más)
    const MAX_LEADS = 200;
    const limitedPlaces = allPlaces.slice(0, MAX_LEADS);

    // 2) Enriquecer cada lugar con teléfono y website
    const leads = [];
    for (const place of limitedPlaces) {
      const lead = await enrichLeadWithDetails(place, apiKey, country);
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
            (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2),
          )
        : 0;

    const executionTime = Date.now() - startTime;

    // 4) Respuesta final (formato amigable para n8n / Lovable)
    return res.json({
      campaignId,
      campaignName,
      categories: categoriesArray,
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
