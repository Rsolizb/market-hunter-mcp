// index.js
// Komerzia Market Hunter MCP - Railway
// Busca negocios en Google Maps y devuelve leads enriquecidos con teléfono y web.

const express = require("express");
const cors = require("cors");
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* -------------------------------------------
   AYUDANTES
-------------------------------------------- */

// Dormir para evitar rate limit
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Códigos de país para normalizar teléfonos
const COUNTRY_CALLING_CODES = {
  Bolivia: "+591",
  Paraguay: "+595",
  Argentina: "+54",
  Brasil: "+55",
  Chile: "+56",
  Peru: "+51",
};

// Normalizador universal de teléfonos
function normalizePhone(raw, country) {
  if (!raw) return "";

  let cleaned = raw.replace(/[^\d+]/g, ""); // quitamos símbolos excepto +

  const countryCode = COUNTRY_CALLING_CODES[country] || "";

  // Si ya viene con +595...
  if (cleaned.startsWith("+")) return cleaned;

  // Si viene 00595...
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;

  // Si empieza con 0 → lo quitamos
  if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);

  // Si no conocemos el código de país, devolvemos el número limpio
  if (!countryCode) return cleaned;

  return `${countryCode}${cleaned}`;
}

/* -------------------------------------------
   BÚSQUEDA POR CATEGORÍA + UBICACIÓN
-------------------------------------------- */

async function searchPlacesByCategory({ category, city, country, apiKey }) {
  const query = encodeURIComponent(`${category} en ${city}, ${country}`);
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;

  const places = [];
  let nextPageToken = null;
  let counter = 0;

  do {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("Error en Text Search:", data.status, data.error_message);
      break;
    }

    if (Array.isArray(data.results)) places.push(...data.results);

    nextPageToken = data.next_page_token || null;

    if (nextPageToken) {
      await sleep(2000);
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${nextPageToken}&key=${apiKey}`;
    }

    counter++;
  } while (nextPageToken && counter < 3);

  return places;
}

/* -------------------------------------------
   FILTRO REAL POR CATEGORÍA
-------------------------------------------- */

function isPlaceRelevant(place, category) {
  const name = (place.name || "").toLowerCase();
  const adr = (place.formatted_address || "").toLowerCase();
  const cat = category.toLowerCase();

  const rules = {
    barberias: ["barber", "barbería", "peluquero", "barber shop"],
    spa: ["spa", "masaje", "relax"],
    "salon de belleza": ["beauty", "salón de belleza", "salon de belleza"],
  };

  if (rules[cat]) {
    return rules[cat].some((kw) => name.includes(kw) || adr.includes(kw));
  }

  // fallback amplio
  return name.includes(cat);
}

/* -------------------------------------------
   PLACE DETAILS: ENRIQUECER LEAD
-------------------------------------------- */

async function enrichLeadWithDetails(place, apiKey, country) {
  const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,international_phone_number,website,rating,geometry,formatted_address,name&key=${apiKey}`;

  try {
    const resp = await fetch(detailsUrl);
    const data = await resp.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.warn("Error en Place Details:", data.status, data.error_message);
    }

    const info = data.result || {};

    const rawPhone =
      info.international_phone_number ||
      info.formatted_phone_number ||
      "";

    const phone = normalizePhone(rawPhone, country);

    return {
      name: info.name || place.name,
      address: info.formatted_address || place.formatted_address,
      phone,
      website: info.website || "",
      rating: info.rating || place.rating || 0,
      place_id: place.place_id,
      location: info.geometry?.location || place.geometry?.location || null,
    };
  } catch (err) {
    console.error("Error en enrichLead:", err);
    return {
      name: place.name,
      address: place.formatted_address,
      phone: "",
      website: "",
      rating: place.rating || 0,
      place_id: place.place_id,
      location: place.geometry?.location || null,
    };
  }
}

/* -------------------------------------------
   ENDPOINT PRINCIPAL
-------------------------------------------- */

app.post("/run-campaign", async (req, res) => {
  const start = Date.now();

  try {
    let {
      campaignId,
      campaignName,
      categories = [],
      city,
      country,
      centerLat,
      centerLng,
      radiusMeters,
    } = req.body || {};

    // 🔹 NUEVO: normalizar categories a array SIEMPRE
    let categoriesArray = [];
    if (Array.isArray(categories)) {
      categoriesArray = categories;
    } else if (typeof categories === "string") {
      // puede venir "barberias" o '["barberias","spa"]'
      try {
        const parsed = JSON.parse(categories);
        if (Array.isArray(parsed)) {
          categoriesArray = parsed;
        } else {
          categoriesArray = [categories];
        }
      } catch {
        categoriesArray = [categories];
      }
    }

    if (!campaignId || !categoriesArray.length || !city || !country) {
      return res.status(400).json({
        error: "Parámetros inválidos",
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Falta GOOGLE_MAPS_API_KEY",
      });
    }

    let allPlaces = [];

    for (const rawCategory of categoriesArray) {
      const catStr = String(rawCategory || "").trim();
      if (!catStr) continue;

      const rawPlaces = await searchPlacesByCategory({
        category: catStr,
        city,
        country,
        apiKey,
      });

      const filtered = rawPlaces.filter((p) =>
        isPlaceRelevant(p, catStr)
      );

      allPlaces.push(...filtered);
    }

    // Eliminar duplicados
    const map = new Map();
    for (const p of allPlaces) {
      if (p.place_id && !map.has(p.place_id)) {
        map.set(p.place_id, p);
      }
    }
    let uniquePlaces = Array.from(map.values());

    // Filtro por radio si hay centro
    if (centerLat && centerLng) {
      const toRad = (x) => (x * Math.PI) / 180;

      function distance(a, b) {
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const R = 6371000; // m
        return (
          2 *
          R *
          Math.asin(
            Math.sqrt(
              Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(a.lat)) *
                  Math.cos(toRad(b.lat)) *
                  Math.sin(dLng / 2) ** 2
            )
          )
        );
      }

      uniquePlaces = uniquePlaces.filter((p) => {
        const loc = p.geometry?.location;
        if (!loc) return false;
        const dist = distance(
          { lat: centerLat, lng: centerLng },
          { lat: loc.lat, lng: loc.lng }
        );
        return dist <= (radiusMeters || 2000);
      });
    }

    // Limitar a 50 negocios
    const limited = uniquePlaces.slice(0, 50);

    const leads = [];
    for (const p of limited) {
      const enriched = await enrichLeadWithDetails(p, apiKey, country);
      leads.push(enriched);
      await sleep(150);
    }

    const ratings = leads
      .map((l) => l.rating)
      .filter((r) => typeof r === "number");

    const summary = {
      total: leads.length,
      avgRating:
        ratings.length > 0
          ? Number(
              (
                ratings.reduce((sum, r) => sum + r, 0) / ratings.length
              ).toFixed(2)
            )
          : 0,
    };

    return res.json({
      campaignId,
      campaignName,
      categories: categoriesArray,
      city,
      country,
      leads,
      executionTime: Date.now() - start,
      summary,
    });
  } catch (err) {
    console.error("Error en /run-campaign:", err);
    return res.status(500).json({
      error: "Error ejecutando campaña",
      details: err.message,
    });
  }
});

/* -------------------------------------------
   HEALTH
-------------------------------------------- */

app.get("/", (_req, res) => {
  res.send("Komerzia Market Hunter MCP is running.");
});

app.listen(PORT, () => {
  console.log(`Market Hunter MCP listening on port ${PORT}`);
});
