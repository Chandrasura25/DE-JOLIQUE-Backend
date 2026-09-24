// Sample catalogue for a fresh store. Images are hosted on Unsplash (provider
// "external"), so they are never deleted from any storage bucket.

const unsplash = (id) => ({
  url: `https://images.unsplash.com/photo-${id}?w=900&q=80&auto=format&fit=crop`,
  key: null,
  provider: 'external',
});

export const categories = [
  { name: 'Fashion', slug: 'fashion', description: 'Everyday clothing and footwear made to last.' },
  { name: 'Electronics', slug: 'electronics', description: 'Audio, wearables and devices for work and play.' },
  { name: 'Home & Living', slug: 'home-living', description: 'Furniture, lighting and kitchen essentials.' },
  { name: 'Beauty', slug: 'beauty', description: 'Skincare and make-up essentials.' },
  { name: 'Accessories', slug: 'accessories', description: 'Bags, watches and finishing touches.' },
];

export const products = [
  // Fashion
  {
    name: 'Essential Cotton Crew Tee',
    category: 'fashion',
    price: 8500,
    stock: 60,
    image: '1521572163474-6864f9cf17ab',
    description:
      'A soft, breathable 100% cotton crew-neck tee with a relaxed fit. Pre-shrunk and garment-washed so it keeps its shape wash after wash.',
  },
  {
    name: 'Classic Leather Biker Jacket',
    category: 'fashion',
    price: 68000,
    stock: 7,
    featured: true,
    image: '1551028719-00167b16eac5',
    description:
      'Timeless asymmetric-zip biker jacket in supple black leather, with quilted shoulders, zipped cuffs and a warm satin lining.',
  },
  {
    name: 'Suede Oxford Shoes',
    category: 'fashion',
    price: 42000,
    stock: 12,
    image: '1560343090-f0409e92791a',
    description:
      'Hand-finished teal suede oxfords with a cushioned leather footbed and a durable rubber sole. Smart enough for the office, easy enough for weekends.',
  },
  {
    name: 'Lightweight Running Sneakers',
    category: 'fashion',
    price: 38500,
    stock: 20,
    image: '1491553895911-0055eca6402d',
    description:
      'Featherlight knit running shoes with responsive foam cushioning and a grippy outsole for road and track.',
  },

  // Electronics
  {
    name: 'Wireless Over-Ear Headphones',
    category: 'electronics',
    price: 54000,
    stock: 15,
    featured: true,
    image: '1505740420928-5e560c06d30e',
    description:
      'Bluetooth over-ear headphones with active noise cancellation, 30-hour battery life, fast USB-C charging and plush memory-foam cushions.',
  },
  {
    name: 'Studio Monitor Headphones',
    category: 'electronics',
    price: 46500,
    stock: 3,
    image: '1583394838336-acd977736f90',
    description:
      'Closed-back wired headphones tuned for accurate, flat sound — ideal for mixing, podcasting and focused listening.',
  },
  {
    name: 'FitPro Smartwatch',
    category: 'electronics',
    price: 89000,
    stock: 10,
    featured: true,
    image: '1546868871-7041f2a55e12',
    description:
      'Always-on AMOLED display, heart-rate and sleep tracking, GPS workouts and up to 7 days of battery. Water resistant to 50m.',
  },
  {
    name: 'Android Smartphone 128GB',
    category: 'electronics',
    price: 245000,
    stock: 5,
    image: '1598327105666-5b89351aff97',
    description:
      '6.5" FHD+ display, 128GB storage, 8GB RAM, 50MP triple camera and a 5000mAh battery with fast charging. Dual SIM.',
  },

  // Home & Living
  {
    name: 'Emerald Velvet 3-Seater Sofa',
    category: 'home-living',
    price: 485000,
    stock: 2,
    featured: true,
    image: '1555041469-a586c61ea9bc',
    description:
      'Mid-century three-seater in rich emerald velvet with a solid hardwood frame, deep foam seats and tapered wooden legs.',
  },
  {
    name: 'Terracotta Loveseat',
    category: 'home-living',
    price: 365000,
    stock: 4,
    image: '1567016432779-094069958ea5',
    description:
      'A compact two-seater in warm terracotta upholstery. Sized for apartments without compromising on comfort.',
  },
  {
    name: 'Mustard Accent Armchair',
    category: 'home-living',
    price: 128000,
    stock: 6,
    image: '1586023492125-27b2c045efd7',
    description:
      'Curved accent chair in mustard fabric on slim wooden legs — a bright reading corner in a single piece.',
  },
  {
    name: 'Arc Floor Lamp',
    category: 'home-living',
    price: 36000,
    stock: 18,
    image: '1507473885765-e6ed057f782c',
    description:
      'Matte grey metal floor lamp with an adjustable shade and weighted base. Takes a standard E27 bulb.',
  },
  {
    name: 'Wood & Steel Bar Stool',
    category: 'home-living',
    price: 32000,
    stock: 24,
    image: '1581539250439-c96689b516dd',
    description:
      'Moulded black seat on a solid wood frame with a steel footrest. Counter height, easy to wipe clean.',
  },
  {
    name: 'Stoneware Tableware Set',
    category: 'home-living',
    price: 24500,
    stock: 30,
    image: '1610701596007-11502861dcfa',
    description:
      'Twelve-piece handmade stoneware set: plates, bowls and cups in a natural speckled glaze. Dishwasher and microwave safe.',
  },
  {
    name: 'Burr Coffee Grinder',
    category: 'home-living',
    price: 58000,
    stock: 9,
    image: '1570222094114-d054a817e56b',
    description:
      'Conical burr grinder with 40 grind settings, from espresso-fine to French-press coarse, for a fresher cup every morning.',
  },
  {
    name: 'Insulated Steel Water Bottle',
    category: 'home-living',
    price: 12500,
    stock: 45,
    image: '1602143407151-7111542de6e8',
    description:
      'Double-walled 750ml stainless steel bottle. Keeps drinks cold for 24 hours or hot for 12. Leak-proof lid.',
  },

  // Beauty
  {
    name: 'Make-up Brush & Essentials Kit',
    category: 'beauty',
    price: 27500,
    stock: 25,
    featured: true,
    image: '1596462502278-27bfdc403348',
    description:
      'Complete kit with eight soft synthetic brushes, a blending sponge and a travel pouch. Cruelty-free.',
  },
  {
    name: 'Gentle Foaming Cleanser',
    category: 'beauty',
    price: 9800,
    stock: 40,
    image: '1620916566398-39f1143ab7be',
    description:
      'A pH-balanced daily cleanser that lifts away make-up and impurities without stripping the skin. Fragrance-free, 150ml.',
  },

  // Accessories
  {
    name: 'Minimalist Analogue Watch',
    category: 'accessories',
    price: 35000,
    stock: 14,
    image: '1523275335684-37898b6baf30',
    description:
      'Clean white dial, slim stainless case and a soft silicone strap. Japanese quartz movement, splash resistant.',
  },
  {
    name: 'Structured Top-Handle Bag',
    category: 'accessories',
    price: 72000,
    stock: 8,
    featured: true,
    image: '1584917865442-de89df76afd3',
    description:
      'Polished red top-handle bag with a detachable shoulder strap, gold-tone hardware and a suede-lined interior.',
  },
  {
    name: 'Tan Leather Crossbody Bag',
    category: 'accessories',
    price: 49500,
    stock: 11,
    image: '1600857062241-98e5dba7f214',
    description:
      'Everyday crossbody in tan pebbled leather with an adjustable strap, zip closure and two inner pockets.',
  },
  {
    name: 'Heritage Leather Backpack',
    category: 'accessories',
    price: 64000,
    stock: 0,
    image: '1622560480605-d83c853bc5c3',
    description:
      'Full-grain leather backpack with a padded 15" laptop sleeve and brass buckles. Ages beautifully with use.',
  },
  {
    name: 'Everyday Canvas Tote',
    category: 'accessories',
    price: 7500,
    stock: 80,
    image: '1544816155-12df9643f363',
    description:
      'Heavyweight natural canvas tote with reinforced handles. Folds flat — perfect for groceries, books and beach days.',
  },
  {
    name: 'Statement Jewellery Set',
    category: 'accessories',
    price: 18000,
    stock: 16,
    image: '1606760227091-3dd870d97f1d',
    description:
      'Mixed set of hoops, layered chains and stacking rings in silver and gold tones. Nickel-free.',
  },
].map((p) => ({ ...p, images: [unsplash(p.image)] }));
