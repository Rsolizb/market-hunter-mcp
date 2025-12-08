const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint principal del MCP
app.post("/run-campaign", async (req, res) => {
  const start = Date.now();

  const {
    campaignId,
    campaignName,
    categories,
    city,
    country
  } = req.body;

  // Validación básica
  if (!campaignId || !campaignName || !categories || !city || !country) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["campaignId", "campaignName", "categories", "city", "country"]
    });
  }

  // Garantizar que sea un array
  const categoriesArray = Array.isArray(categories) ? categories : [categories];
  const queryString = `${categoriesArray.join(", ")} in ${city}, ${country}`;

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
    queryString
  )}&key=${process.env.GOOGLE_MAPS_API_KEY}`;

  try {
    const result = await fetch(url);
    const data = await result.json();

    const leads = (data.results || []).map((place) => ({
      name: place.name,
      address: place.formatted_address || "",
      rating: place.rating || null,
      location: place.geometry?.location || null,
      place_id: place.place_id || null
    }));

    const executionTime = Date.now() - start;

    // Calcular rating promedio
    const ratedLeads = leads.filter((l) => l.rating);
    const avgRating =
      ratedLeads.length > 0
        ? ratedLeads.reduce((sum, l) => sum + l.rating, 0) / ratedLeads.length
        : 0;

    return res.json({
      campaignId,
      campaignName,
      categories: categoriesArray,
      city,
      country,
      leads,
      executionTime,
      summary: {
        total: leads.length,
        avgRating
      }
    });
  } catch (err) {
    console.error("Error in /run-campaign:", err);
    return res.status(500).json({
      error: "Error executing campaign",
      details: err.toString()
    });
  }
});

// Railway usa process.env.PORT automáticamente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Market Hunter MCP running on port ${PORT}`);
});
