import { pathToFileURL } from "node:url";
import { connectDatabase } from "../src/db.js";
export const sampleProducts = [
  [
    "The Solstice Hoops",
    "Earrings",
    1290,
    490,
    "earrings",
    "Sculptural hoops with a warm gold-tone finish. A light-catching curve for your everyday rotation.",
  ],
  [
    "The Luna Pendant",
    "Necklaces",
    1890,
    720,
    "necklace",
    "A small luminous pendant on a delicate chain. Layer it with your favorites or let it stand beautifully alone.",
  ],
  [
    "The Muse Ring",
    "Rings",
    990,
    350,
    "ring",
    "An organic statement ring with a softly rounded silhouette. Designed to bring a little character to simple styling.",
  ],
  [
    "The Orbit Bangle",
    "Bangles",
    1490,
    550,
    "bangle",
    "A clean circular bangle with a subtle hammered texture. Wear one for simplicity or pair with other pieces.",
  ],
  [
    "The Pearl Edit",
    "Earrings",
    1690,
    640,
    "pearl",
    "Pearl-inspired drops paired with a polished gold-tone setting. An effortless finishing touch for evening or everyday.",
  ],
  [
    "The Everyday Chain",
    "Bracelets",
    1190,
    430,
    "bracelet",
    "A fine linked bracelet with a comfortable clasp. A considered little detail for your daily accessories collection.",
  ],
  [
    "The Golden Hour Ring",
    "Rings",
    1390,
    510,
    "ring",
    "A bold, curved gold-tone band with an open sculptural shape. Made for mixing, matching, and making it your own.",
  ],
  [
    "The Petal Clip",
    "Hair accessories",
    790,
    260,
    "clip",
    "A floral-inspired hair clip in a soft metallic finish. Sweep back your hair and add a gentle touch of shine.",
  ],
].map(([name, category, price, cost, art, description], i) => ({
  name,
  slug: name.toLowerCase().replaceAll(" ", "-"),
  category,
  pricePaisa: price * 100,
  costPaisa: cost * 100,
  stock: 12 + i,
  images: [`/images/${art}.svg`],
  description,
  material:
    "Gold-tone alloy; sample specification — replace with your actual product material.",
  care: "Keep dry. Avoid perfume and harsh chemicals. Wipe with a soft cloth and store separately.",
  featured: i < 4,
  active: true,
  isSample: true,
}));
export async function seed(db) {
  let added = 0;
  for (const product of sampleProducts) {
    const result = await db
      .collection("products")
      .updateOne(
        { slug: product.slug },
        {
          $setOnInsert: {
            ...product,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    added += result.upsertedCount;
  }
  return added;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { db, client } = await connectDatabase();
  try {
    console.log(
      `Added ${await seed(db)} sample products. Existing products were preserved. Replace sample descriptions, images and stock before launch.`,
    );
  } finally {
    await client.close();
  }
}
