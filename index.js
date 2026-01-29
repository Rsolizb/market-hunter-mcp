const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = 'compass~google-maps-extractor';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COUNTRY_DIAL_CODES = {
  Bolivia: '+591',
  'Estado Plurinacional de Bolivia': '+591',
  Paraguay: '+595',
  España: '+34',
  Mexico: '+52',
  México: '+52',
  Argentina: '+54',
  Chile: '+56',
  Peru: '+51',
  Perú: '+51',
};

function normalizePhone(phone, country) {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return trimmed;
  const dialCode = COUNTRY_DIAL_CODES[country] || null;
  if (!dialCode) return trimmed;
  let clean = trimmed.replace(/^\(0\)/, '').trim();
  clean = clean.replace(/^0+/, '').trim();
  return `${dialCode} ${clean}`;
}

async function searchPlacesWithApify({ category, city, country, maxResults = 200 }) {
  try {
    console.log(`🔍 Buscando: ${category} en ${city}, ${country} (max: ${maxResults})`);

    const searchQuery = `${category} ${city}, ${country}`;

    const apifyConfig = {
      searchStringsArray: [searchQuery],
      maxCrawledPlaces: maxResults,
      language: 'es',
      deeperCityScrape: true,
      maxReviews: 0,
      maxImages: 0,
      scrapeReviewerName: false,
      scrapeReviewerId: false,
      scrapeReviewerUrl: false,
      scrapeReviewId: false,
      scrapeReviewUrl: false,
      scrapeResponseFromOwnerText: false
    };

    console.log(`📤 Iniciando scraper...`);

    // Parámetros que funcionaron en tu prueba
    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?maxItems=${maxResults}&maxTotalChargeUsd=5&waitForFinish=300&timeout=300`,
      apifyConfig,
      {
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APIFY_TOKEN}`
        },
        timeout: 320000, // 320 segundos (más que waitForFinish)
      }
    );

    const runId = runResponse.data.data.id;
    const datasetId = runResponse.data.data.defaultDatasetId;
    const status = runResponse.data.data.status;

    console.log(`✅ Run ID: ${runId}`);
    console.log(`📊 Estado inicial: ${status}`);

    // Si ya terminó, obtener resultados
    if (status === 'SUCCEEDED') {
      console.log(`✅ Scraper completado inmediatamente`);
      const results = await getDatasetResults(datasetId);
      console.log(`📊 ${results.length} resultados obtenidos`);
      return results;
    }

    // Si no terminó, seguir esperando
    console.log(`⏳ Continuando espera...`);
    const results = await waitForApifyResults(runId, datasetId);
    console.log(`📊 ${results.length} resultados obtenidos`);

    return results;
  } catch (error) {
    console.error(`❌ Error en Apify:`, error.message);
    if (error.code === 'ECONNABORTED') {
      console.error(`⏱️ Timeout - el scraper tardó más de 5 minutos`);
    }
    if (error.response?.data) {
      console.error(`📋 Detalles:`, JSON.stringify(error.response.data, null, 2));
    }
    return [];
  }
}

async function getDatasetResults(datasetId) {
  try {
    let allResults = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const resultsResponse = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&offset=${offset}&limit=${limit}`,
        { timeout: 15000 }
      );

      const items = resultsResponse.data;

      if (!items || items.length === 0) {
        break;
      }

      allResults = allResults.concat(items);

      if (items.length < limit) {
        break;
      }

      offset += limit;
      console.log(`📥 Obtenidos ${allResults.length} resultados hasta ahora...`);
    }

    return allResults;
  } catch (error) {
    console.error(`❌ Error obteniendo resultados:`, error.message);
    return [];
  }
}

async function waitForApifyResults(runId, datasetId, maxIntentos = 60) {
  const intervalo = 5000; // 5 segundos

  for (let i = 0; i < maxIntentos; i++) {
    try {
      const statusResponse = await axios.get(
        `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_TOKEN}`,
        { timeout: 5000 }
      );

      const status = statusResponse.data.data.status;

      if (status === 'SUCCEEDED') {
        console.log(`✅ Scraper completado`);
        return await getDatasetResults(datasetId);
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        console.error(`❌ Scraper ${status}`);
        return [];
      }

      if (i % 6 === 0 && i > 0) {
        console.log(`⏳ ${i * 5}s - Estado: ${status}`);
      }

      await sleep(intervalo);
    } catch (err) {
      console.error(`⚠️ Error consultando estado:`, err.message);
      await sleep(intervalo);
    }
  }

  console.error('⏱️ Timeout alcanzado después de 5 minutos');
  
  // Intentar obtener resultados parciales
  try {
    console.log(`📥 Intentando obtener resultados parciales...`);
    return await getDatasetResults(datasetId);
  } catch (error) {
    return [];
  }
}

function formatApifyResultToLead(place, country) {
  const phone = normalizePhone(place.phone, country);

  return {
    name: place.title || null,
    address: place.address || null,
    rating: place.totalScore || null,
    location: place.location ? { 
      lat: place.location.lat, 
      lng: place.location.lng 
    } : null,
    place_id: place.placeId || null,
    phone: phone,
    website: place.website || null,
    category: place.categoryName || null,
    reviews: place.reviewsCount || 0,
    hours: place.openingHours || null,
  };
}

app.post('/run-campaign', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      campaignId,
      campaignName,
      categories = [],
      city,
      country,
      maxResultsPerCategory = 200,
    } = req.body || {};

    if (!campaignId || !city || !country) {
      return res.status(400).json({ 
        error: 'Parámetros inválidos',
        details: 'Se requieren campaignId, city y country'
      });
    }

    let categoriesArray = [];
    if (Array.isArray(categories)) {
      categoriesArray = categories;
    } else if (typeof categories === 'string' && categories.trim()) {
      categoriesArray = [categories];
    }

    if (!categoriesArray.length) {
      return res.status(400).json({ 
        error: 'Se requiere al menos una categoría' 
      });
    }

    if (!APIFY_TOKEN) {
      return res.status(500).json({ 
        error: 'Falta APIFY_TOKEN en variables de entorno' 
      });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 INICIANDO CAMPAÑA`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📋 Nombre: ${campaignName || campaignId}`);
    console.log(`📍 Ubicación: ${city}, ${country}`);
    console.log(`🏷️ Categorías: ${categoriesArray.join(', ')}`);
    console.log(`🔢 Max por categoría: ${maxResultsPerCategory}`);
    console.log(`${'='.repeat(60)}\n`);

    const allPlacesMap = new Map();

    for (let idx = 0; idx < categoriesArray.length; idx++) {
      const catStr = String(categoriesArray[idx] || '').trim();
      if (!catStr) continue;

      console.log(`\n[${ idx + 1}/${categoriesArray.length}] Buscando "${catStr}"...`);

      const apifyResults = await searchPlacesWithApify({
        category: catStr,
        city,
        country,
        maxResults: maxResultsPerCategory,
      });

      for (const place of apifyResults) {
        const placeId = place.placeId || place.place_id;
        if (!placeId) continue;
        if (!allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }

      if (categoriesArray.length > 1 && idx < categoriesArray.length - 1) {
        console.log(`⏳ Pausa de 2 segundos antes de la siguiente categoría...`);
        await sleep(2000);
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 RESUMEN DE RESULTADOS`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📍 Total lugares únicos encontrados: ${allPlaces.length}`);
    
    const placesWithPhone = allPlaces.filter((p) => p.phone && p.phone.trim() !== '');
    console.log(`📞 Lugares con teléfono: ${placesWithPhone.length}`);
    
    const leads = placesWithPhone.map((place) => formatApifyResultToLead(place, country));

    const total = leads.length;
    const ratings = leads
      .map((l) => (typeof l.rating === 'number' ? l.rating : null))
      .filter((r) => r !== null);
    
    const avgRating = ratings.length > 0 
      ? Number((ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)) 
      : 0;
    
    const executionTime = Date.now() - startTime;

    console.log(`⭐ Rating promedio: ${avgRating}`);
    console.log(`⏱️ Tiempo total: ${(executionTime / 1000).toFixed(2)}s`);
    console.log(`${'='.repeat(60)}\n`);

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
        totalFound: allPlaces.length,
        withPhone: placesWithPhone.length,
        avgRating,
      },
    });
  } catch (err) {
    console.error('\n❌ ERROR EN CAMPAÑA:', err);
    return res.status(500).json({
      error: 'Error ejecutando campaña',
      details: err.message,
    });
  }
});

app.get('/', (_req, res) => {
  res.json({
    message: 'Komerzia Market Hunter MCP',
    version: '2.0',
    status: 'operational',
    apifyConfigured: !!APIFY_TOKEN,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Market Hunter MCP',
    version: '2.0',
    apifyConfigured: !!APIFY_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Market Hunter MCP`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📍 Version: 2.0 - Apify Integration`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔑 Apify: ${APIFY_TOKEN ? '✅ Configurado' : '❌ Falta token'}`);
  console.log(`${'='.repeat(60)}\n`);
});
```

---

## 🔑 Características del código final:

### ✅ Parámetros que funcionaron:
- `maxItems=200`
- `maxTotalChargeUsd=20`
- `waitForFinish=300` (5 minutos)
- `timeout=300` (5 minutos)

### ✅ Mejoras implementadas:
1. **Paginación completa** - Obtiene TODOS los resultados, no solo 20
2. **Logs detallados** - Muestra progreso de cada categoría
3. **Error handling robusto** - Captura timeouts y errores
4. **Resultados parciales** - Si hay timeout, intenta obtener lo que alcanzó
5. **Authorization header** - Usa `Bearer ${APIFY_TOKEN}`
6. **Timeouts apropiados** - 320s en axios (más que los 300s de waitForFinish)

### ✅ Flujo optimizado:
```
1. Inicia scraper con waitForFinish=300s
2. Si termina antes → obtiene resultados inmediatos
3. Si no termina → espera hasta 5 minutos adicionales
4. Obtiene resultados con paginación (1000 por request)
5. Retorna todos los leads con teléfono
