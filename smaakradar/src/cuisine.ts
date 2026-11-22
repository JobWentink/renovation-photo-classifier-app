/** Keukens: Google primaryType / OSM cuisine-tag → Nederlands label + emoji. */
interface Cuisine {
  label: string;
  emoji: string;
}

const C: Record<string, Cuisine> = {
  italian: { label: 'Italiaans', emoji: '🍝' },
  pizza: { label: 'Pizza', emoji: '🍕' },
  japanese: { label: 'Japans', emoji: '🍱' },
  sushi: { label: 'Sushi', emoji: '🍣' },
  ramen: { label: 'Ramen', emoji: '🍜' },
  chinese: { label: 'Chinees', emoji: '🥡' },
  thai: { label: 'Thais', emoji: '🍛' },
  vietnamese: { label: 'Vietnamees', emoji: '🍜' },
  korean: { label: 'Koreaans', emoji: '🥘' },
  indian: { label: 'Indiaas', emoji: '🍛' },
  indonesian: { label: 'Indonesisch', emoji: '🍚' },
  asian: { label: 'Aziatisch', emoji: '🥢' },
  french: { label: 'Frans', emoji: '🥐' },
  spanish: { label: 'Spaans', emoji: '🥘' },
  tapas: { label: 'Tapas', emoji: '🫒' },
  greek: { label: 'Grieks', emoji: '🫒' },
  turkish: { label: 'Turks', emoji: '🥙' },
  lebanese: { label: 'Libanees', emoji: '🧆' },
  middle_eastern: { label: 'Midden-Oosters', emoji: '🧆' },
  mediterranean: { label: 'Mediterraans', emoji: '🫒' },
  mexican: { label: 'Mexicaans', emoji: '🌮' },
  american: { label: 'Amerikaans', emoji: '🍔' },
  burger: { label: 'Burgers', emoji: '🍔' },
  hamburger: { label: 'Burgers', emoji: '🍔' },
  steak_house: { label: 'Steakhouse', emoji: '🥩' },
  steak: { label: 'Steakhouse', emoji: '🥩' },
  seafood: { label: 'Vis & zeevruchten', emoji: '🦞' },
  fish: { label: 'Vis & zeevruchten', emoji: '🐟' },
  vegetarian: { label: 'Vegetarisch', emoji: '🥗' },
  vegan: { label: 'Vegan', emoji: '🌱' },
  breakfast: { label: 'Ontbijt & brunch', emoji: '🍳' },
  brunch: { label: 'Ontbijt & brunch', emoji: '🥞' },
  dutch: { label: 'Hollands', emoji: '🧀' },
  regional: { label: 'Hollands', emoji: '🧀' },
  surinamese: { label: 'Surinaams', emoji: '🍗' },
  ethiopian: { label: 'Ethiopisch', emoji: '🫓' },
  african: { label: 'Afrikaans', emoji: '🍲' },
  brazilian: { label: 'Braziliaans', emoji: '🥩' },
  argentinian: { label: 'Argentijns', emoji: '🥩' },
  peruvian: { label: 'Peruaans', emoji: '🐟' },
  fine_dining: { label: 'Fine dining', emoji: '🥂' },
  bar: { label: 'Bar & bites', emoji: '🍷' },
  wine_bar: { label: 'Wijnbar', emoji: '🍷' },
  cafe: { label: 'Café', emoji: '☕' },
  coffee: { label: 'Koffie', emoji: '☕' },
  bakery: { label: 'Bakkerij', emoji: '🥖' },
  dessert: { label: 'Dessert', emoji: '🍨' },
  ice_cream: { label: 'IJs', emoji: '🍦' },
  bbq: { label: 'Barbecue', emoji: '🍖' },
  barbecue: { label: 'Barbecue', emoji: '🍖' },
  international: { label: 'Internationaal', emoji: '🌍' },
  fusion: { label: 'Fusion', emoji: '✨' },
  poke: { label: 'Poké', emoji: '🥗' },
  hawaiian: { label: 'Poké', emoji: '🥗' },
  georgian: { label: 'Georgisch', emoji: '🥟' },
  dumplings: { label: 'Dumplings', emoji: '🥟' },
  chicken: { label: 'Kip', emoji: '🍗' },
};

const FALLBACK: Cuisine = { label: 'Restaurant', emoji: '🍽️' };

/** "italian_restaurant" → italian, "steak_house" → steak_house, "italian;pizza" → italian */
export function cuisineFor(raw?: string | null): Cuisine {
  if (!raw) return FALLBACK;
  const first = raw.toLowerCase().split(/[;,]/)[0].trim();
  const key = first.replace(/_restaurant$/, '').replace(/_shop$/, '').replace(/\s+/g, '_');
  if (C[key]) return C[key];
  if (C[first]) return C[first];
  if (key === 'restaurant' || key === 'food' || key === 'meal_takeaway' || key === 'meal_delivery') return FALLBACK;
  // Onbekend: maak er een leesbaar label van
  const label = key.replace(/_/g, ' ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), emoji: '🍽️' };
}

/** Kies het meest specifieke Google-type uit de lijst. */
export function cuisineFromGoogleTypes(primary?: string, types: string[] = []): Cuisine {
  if (primary && primary !== 'restaurant' && cuisineFor(primary) !== FALLBACK) return cuisineFor(primary);
  for (const t of types) {
    if (t.endsWith('_restaurant') || C[t]) {
      const c = cuisineFor(t);
      if (c !== FALLBACK) return c;
    }
  }
  return FALLBACK;
}
