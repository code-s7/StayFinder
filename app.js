require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Listing = require("./models/listing");
const User = require("./models/user");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/stayfinder";
const NAV_CATEGORIES = [
  { key: "all", label: "All" },
  { key: "room-hostel-pg", label: "Room / Hostel / PG" },
  { key: "office", label: "Office" },
  { key: "shop", label: "Shops / Showrooms" },
];

mongoose
  .connect(MONGO_URL)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.log("MongoDB error:", err));

const dropLegacyUserIndexIfPresent = async () => {
  try {
    const indexes = await User.collection.indexes();
    const hasLegacyUsernameIndex = indexes.some((index) => index.name === "username_1");

    if (hasLegacyUsernameIndex) {
      await User.collection.dropIndex("username_1");
      console.log("Dropped legacy users.username_1 index.");
    }
  } catch (error) {
    console.warn("Legacy index cleanup skipped:", error.message);
  }
};

const markLegacyUsersVerified = async () => {
  try {
    const result = await User.updateMany(
      { isEmailVerified: { $exists: false } },
      { $set: { isEmailVerified: true } }
    );
    if (result.modifiedCount) {
      console.log(`Marked ${result.modifiedCount} legacy users as email-verified.`);
    }
  } catch (error) {
    console.warn("Legacy user verification migration skipped:", error.message);
  }
};

mongoose.connection.once("open", () => {
  dropLegacyUserIndexIfPresent();
  markLegacyUsersVerified();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "stayfinder-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

const setFlash = (req, type, message) => {
  req.session.flash = { type, message };
};

const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24;
const googleClientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
const googleOAuthClient = googleClientId ? new OAuth2Client(googleClientId) : null;

const buildBaseUrl = (req) => {
  const configured = (process.env.APP_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
};

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const generateEmailVerificationToken = () => crypto.randomBytes(32).toString("hex");

const getEmailTransporter = () => {
  const host = (process.env.SMTP_HOST || "").trim();
  const user = (process.env.SMTP_USER || "").trim();
  const pass = (process.env.SMTP_PASS || "").trim();
  const from = (process.env.EMAIL_FROM || user).trim();
  if (!host || !user || !pass || !from) return null;

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth: { user, pass },
  });
};

const sendVerificationEmail = async ({ req, user, token }) => {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.warn("Email verification skipped: SMTP is not configured.");
    return false;
  }

  const verifyUrl = `${buildBaseUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
  const fromAddress = (process.env.EMAIL_FROM || process.env.SMTP_USER || "").trim();
  await transporter.sendMail({
    from: fromAddress,
    to: user.email,
    subject: "Verify your StayFinder email",
    text: `Hi ${user.name},\n\nPlease verify your email by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\n- StayFinder`,
  });
  return true;
};

const createAndSendVerificationToken = async (req, user) => {
  const token = generateEmailVerificationToken();
  user.emailVerificationTokenHash = hashToken(token);
  user.emailVerificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  await user.save();
  return sendVerificationEmail({ req, user, token });
};

const sanitizeSessionUser = (userDoc) => ({
  id: userDoc._id.toString(),
  name: userDoc.name,
  email: userDoc.email,
});

const verifyGoogleCredential = async (credential) => {
  if (!googleOAuthClient) {
    throw new Error("Google login is not configured.");
  }
  const ticket = await googleOAuthClient.verifyIdToken({
    idToken: credential,
    audience: googleClientId,
  });
  return ticket.getPayload();
};

const categoryLabelByKey = {
  "room-hostel-pg": "Room / Hostel / PG",
  room: "Room / Hostel / PG",
  office: "Office",
  shop: "Shops / Showrooms",
};

let geminiClient;
const getGeminiClient = () => {
  if (geminiClient) return geminiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  geminiClient = new GoogleGenerativeAI(apiKey);
  return geminiClient;
};

const getGeminiModelCandidates = () => {
  const envModel = (process.env.GEMINI_MODEL || "").trim();
  const envList = (process.env.GEMINI_MODELS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const defaults = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash-8b"];
  const ordered = [envModel, ...envList, ...defaults].filter(Boolean);
  return [...new Set(ordered)];
};

const parseJsonObjectFromText = (text) => {
  if (!text) return null;
  const trimmed = String(text).trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // Continue to fenced/extracted JSON fallback.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch (error) {
      // Continue to broad extraction fallback.
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (error) {
      return null;
    }
  }

  return null;
};

const parseBudgetFromText = (queryText) => {
  const text = String(queryText || "").toLowerCase();
  const underMatch = text.match(
    /(under|below|less than|max(?:imum)?|upto|up to)\s*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*)/
  );
  if (underMatch) {
    return { maxPrice: Number(underMatch[2].replace(/,/g, "")) };
  }

  const nearMatch = text.match(
    /(around|approx|approximately|about|near)\s*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*)/
  );
  if (nearMatch) {
    const value = Number(nearMatch[2].replace(/,/g, ""));
    return { minPrice: Math.max(0, Math.floor(value * 0.8)), maxPrice: Math.ceil(value * 1.2) };
  }

  const betweenMatch = text.match(
    /between\s*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*)\s*(?:and|-|to)\s*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*)/
  );
  if (betweenMatch) {
    const min = Number(betweenMatch[1].replace(/,/g, ""));
    const max = Number(betweenMatch[2].replace(/,/g, ""));
    return { minPrice: Math.min(min, max), maxPrice: Math.max(min, max) };
  }

  return {};
};

const extractIntentHeuristically = (queryText) => {
  const text = String(queryText || "").trim();
  const lower = text.toLowerCase();
  const budget = parseBudgetFromText(text);

  let category = null;
  if (/(office|workspace|cowork|co-work|commercial)/i.test(lower)) category = "office";
  else if (/(shop|showroom|retail|store)/i.test(lower)) category = "shop";
  else if (/(pg|hostel|room|flatmate|co-living|coliving)/i.test(lower)) category = "room-hostel-pg";

  let location = "";
  const nearMatch = text.match(/(?:near|in|at)\s+([a-z0-9\s,'-]{3,})/i);
  if (nearMatch) {
    location = nearMatch[1]
      .replace(/\s+(under|below|between|around|max).*$/i, "")
      .trim();
  }

  const normalized = {
    category,
    minPrice: Number.isFinite(budget.minPrice) ? budget.minPrice : null,
    maxPrice: Number.isFinite(budget.maxPrice) ? budget.maxPrice : null,
    location: location || null,
    keywords: [],
  };

  return normalized;
};

const extractSearchIntentWithAI = async (queryText) => {
  const client = getGeminiClient();
  if (!client) {
    return { intent: extractIntentHeuristically(queryText), source: "heuristic" };
  }

  const prompt = `
Extract structured property-search intent from the user query for StayFinder.
Return STRICT JSON only with this schema:
{
  "category": "office" | "shop" | "room-hostel-pg" | null,
  "minPrice": number | null,
  "maxPrice": number | null,
  "location": string | null,
  "keywords": string[]
}

Rules:
- Price is monthly INR. If user says "under 5000", set maxPrice=5000.
- If budget is approximate, infer a sensible minPrice/maxPrice range.
- location should be concise.
- Use only supported categories listed above.
- If unknown, keep field null.

User query: ${queryText}
`;

  const modelCandidates = getGeminiModelCandidates();
  let lastError = null;

  for (const modelName of modelCandidates) {
    try {
      const model = client.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const parsed = parseJsonObjectFromText(responseText);
      if (!parsed || typeof parsed !== "object") {
        lastError = new Error(`Model ${modelName} returned non-JSON intent.`);
        continue;
      }

      const normalized = {
        category: ["office", "shop", "room-hostel-pg"].includes(parsed.category)
          ? parsed.category
          : null,
        minPrice: Number.isFinite(parsed.minPrice) ? Math.max(0, Number(parsed.minPrice)) : null,
        maxPrice: Number.isFinite(parsed.maxPrice) ? Math.max(0, Number(parsed.maxPrice)) : null,
        location:
          typeof parsed.location === "string" && parsed.location.trim()
            ? parsed.location.trim()
            : null,
        keywords: Array.isArray(parsed.keywords)
          ? parsed.keywords
              .map((item) => String(item || "").trim())
              .filter(Boolean)
              .slice(0, 6)
          : [],
      };

      return { intent: normalized, source: "ai", model: modelName };
    } catch (error) {
      lastError = error;
      const errorMessage = String(error.message || "");
      console.warn(`Gemini intent model failed (${modelName}): ${errorMessage}`);
    }
  }

  console.warn("Falling back to heuristic intent extraction:", lastError && lastError.message);
  return { intent: extractIntentHeuristically(queryText), source: "heuristic" };
};

const buildListingQueryFromIntent = ({ selectedCategory, city, naturalQuery, intent }) => {
  const query = {};

  // Keep existing chip-based category behavior as default.
  if (selectedCategory === "room-hostel-pg") {
    query.category = { $in: ["room-hostel-pg", "room"] };
  } else if (selectedCategory !== "all") {
    query.category = selectedCategory;
  }

  // Natural language category overrides only when "all" chip is selected.
  if (selectedCategory === "all" && intent?.category) {
    if (intent.category === "room-hostel-pg") {
      query.category = { $in: ["room-hostel-pg", "room"] };
    } else {
      query.category = intent.category;
    }
  }

  const activeLocation = (intent?.location || city || "").trim();
  if (activeLocation) {
    query.location = { $regex: activeLocation, $options: "i" };
  }

  const minPrice = Number.isFinite(intent?.minPrice) ? intent.minPrice : null;
  const maxPrice = Number.isFinite(intent?.maxPrice) ? intent.maxPrice : null;
  if (minPrice !== null || maxPrice !== null) {
    query.price = {};
    if (minPrice !== null) query.price.$gte = minPrice;
    if (maxPrice !== null) query.price.$lte = maxPrice;
  }

  if (!query.location && Array.isArray(intent?.keywords) && intent.keywords.length) {
    query.$or = intent.keywords.slice(0, 4).flatMap((keyword) => [
      { title: { $regex: keyword, $options: "i" } },
      { description: { $regex: keyword, $options: "i" } },
    ]);
  }

  // Preserve backward compatibility if only plain city text is provided.
  if (!naturalQuery && city && !query.location) {
    query.location = { $regex: city, $options: "i" };
  }

  return query;
};

const isLoggedIn = (req, res, next) => {
  if (!req.session.user) {
    setFlash(req, "error", "Please login to continue.");
    return res.redirect("/login");
  }
  next();
};

const isGuestOnly = (req, res, next) => {
  if (req.session.user) {
    return res.redirect("/listings");
  }
  next();
};

const isListingOwner = async (req, res, next) => {
  const { id } = req.params;
  const listing = await Listing.findById(id).select("owner");

  if (!listing) {
    return res.status(404).send("Listing not found");
  }

  if (!listing.owner || listing.owner.toString() !== req.session.user.id) {
    setFlash(req, "error", "You are not authorized to manage this listing.");
    return res.redirect(`/listings/${id}`);
  }

  req.listing = listing;
  next();
};

app.use((req, res, next) => {
  res.locals.navCategories = NAV_CATEGORIES;
  res.locals.selectedCategory = "all";
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.googleClientId = googleClientId;
  delete req.session.flash;
  next();
});

app.get("/", (req, res) => {
  res.redirect("/listings");
});

app.get("/listings", async (req, res) => {
  const selectedCategory = req.query.category || "all";
  const city = (req.query.city || "").trim();
  const naturalQuery = (req.query.q || "").trim();
  res.locals.selectedCategory = selectedCategory;
  res.locals.searchCity = city;
  res.locals.searchNaturalQuery = naturalQuery;
  res.locals.searchIntent = null;
  res.locals.searchIntentSource = null;

  let intent = null;
  let intentSource = null;
  if (naturalQuery) {
    const parsed = await extractSearchIntentWithAI(naturalQuery);
    intent = parsed.intent;
    intentSource = parsed.source;
    res.locals.searchIntent = intent;
    res.locals.searchIntentSource = intentSource;
  }

  const query = buildListingQueryFromIntent({
    selectedCategory,
    city,
    naturalQuery,
    intent,
  });

  const listings = await Listing.find(query).sort({ createdAt: -1 });
  res.render("listings/index", { listings });
});

app.get("/listings/new", (req, res) => {
  if (!req.session.user) {
    setFlash(req, "error", "Please login to create a listing.");
    return res.redirect("/login");
  }
  res.render("listings/new");
});

app.post("/ai/listings/description", isLoggedIn, async (req, res) => {
  const geminiClient = getGeminiClient();
  if (!geminiClient) {
    return res.status(503).json({
      error: "Gemini is not configured. Please set GEMINI_API_KEY in your environment.",
    });
  }

  const { title, category, location, price, highlights } = req.body || {};
  if (!title || !category || !location) {
    return res.status(400).json({
      error: "Title, category, and location are required to generate description.",
    });
  }

  const cleanHighlights = typeof highlights === "string" ? highlights.trim() : "";
  const categoryLabel = categoryLabelByKey[category] || "Property";
  const priceText = price ? `INR ${price} per month` : "pricing on request";

  const prompt = `
Write one compelling property listing description for StayFinder.
Property details:
- Title: ${title}
- Category: ${categoryLabel}
- Location: ${location}
- Price: ${priceText}
- Highlights: ${cleanHighlights || "Not provided"}

Requirements:
- 80 to 120 words.
- Professional and trustworthy tone.
- Mention location convenience, value, and who this place is ideal for.
- Do not use markdown, bullets, emojis, or quotation marks.
- Return only the final description text.
`;

  const modelCandidates = getGeminiModelCandidates();
  let lastError = null;

  for (const modelName of modelCandidates) {
    try {
      const model = geminiClient.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const description = result.response.text().trim();

      if (!description) {
        lastError = new Error(`Model ${modelName} returned empty response.`);
        continue;
      }

      return res.json({ description, model: modelName });
    } catch (error) {
      lastError = error;
      const errorMessage = String(error.message || "");
      console.warn(`Gemini model failed (${modelName}): ${errorMessage}`);
      continue;
    }
  }

  console.error("Gemini generation failed on all models:", lastError && lastError.message);
  res.status(500).json({
    error:
      "Unable to generate description right now. Please try again in a minute or set GEMINI_MODEL to a supported model.",
  });
});

app.get("/chat", (req, res) => {
  res.render("chat/index");
});

app.post("/ai/chat", async (req, res) => {
  const client = getGeminiClient();
  if (!client) {
    return res.status(503).json({
      error: "Gemini is not configured. Please set GEMINI_API_KEY in your environment.",
    });
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  const recentHistory = history
    .slice(-8)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: typeof item.text === "string" ? item.text.trim() : "",
    }))
    .filter((item) => item.text);

  const latestListings = await Listing.find({})
    .sort({ createdAt: -1 })
    .limit(8)
    .select("title category price location")
    .lean();

  const listingContext = latestListings.length
    ? latestListings
        .map(
          (listing, index) =>
            `${index + 1}. ${listing.title} | ${
              categoryLabelByKey[listing.category] || listing.category || "Property"
            } | INR ${listing.price}/month | ${listing.location}`
        )
        .join("\n")
    : "No recent listings available right now.";

  const systemPrompt = `
You are StayFinder Conversational Property Assistant.
You help users discover offices, PGs, rooms, hostels, and shops based on budget, location, and preferences.

Behavior guidelines:
- Be practical, friendly, and concise.
- If user asks with budget (e.g., "I have 20000 budget"), suggest suitable property types and realistic expectations.
- If needed, ask 1-2 short follow-up questions (city, team size, furnished/unfurnished, lease duration).
- Use INR in pricing guidance.
- Prefer recommendations aligned with StayFinder categories: Room / Hostel / PG, Office, Shops / Showrooms.
- Mention trade-offs clearly (location vs size vs amenities).
- If the query is unrelated to property, politely redirect to property guidance.
- Do not claim to perform actions outside chat.

Recent StayFinder listings:
${listingContext}
`;

  const chatTranscript = recentHistory
    .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.text}`)
    .join("\n");

  const finalPrompt = `${systemPrompt}

Conversation so far:
${chatTranscript || "No previous messages."}

User: ${message}
Assistant:`;

  const modelCandidates = getGeminiModelCandidates();
  let lastError = null;

  for (const modelName of modelCandidates) {
    try {
      const model = client.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(finalPrompt);
      const reply = result.response.text().trim();

      if (!reply) {
        lastError = new Error(`Model ${modelName} returned empty response.`);
        continue;
      }

      return res.json({ reply, model: modelName });
    } catch (error) {
      lastError = error;
      const errorMessage = String(error.message || "");
      console.warn(`Gemini chat model failed (${modelName}): ${errorMessage}`);
    }
  }

  console.error("Gemini chat failed on all models:", lastError && lastError.message);
  return res.status(500).json({
    error:
      "Unable to get assistant response right now. Please try again in a minute or set GEMINI_MODEL to a supported model.",
  });
});

app.post("/listings", isLoggedIn, async (req, res) => {
  const listing = new Listing({
    ...req.body.listing,
    owner: req.session.user.id,
  });
  await listing.save();
  setFlash(req, "success", "Listing created successfully.");
  res.redirect(`/listings/${listing._id}`);
});

app.get("/listings/:id", async (req, res) => {
  const { id } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    return res.status(404).send("Listing not found");
  }
  const canManageListing =
    req.session.user && listing.owner && listing.owner.toString() === req.session.user.id;
  res.render("listings/show", { listing, canManageListing });
});

app.get("/listings/:id/edit", isLoggedIn, isListingOwner, async (req, res) => {
  const { id } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    return res.status(404).send("Listing not found");
  }
  res.render("listings/edit", { listing });
});

app.put("/listings/:id", isLoggedIn, isListingOwner, async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body.listing };
  delete updates.owner;

  await Listing.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  });
  setFlash(req, "success", "Listing updated successfully.");
  res.redirect(`/listings/${id}`);
});

app.delete("/listings/:id", isLoggedIn, isListingOwner, async (req, res) => {
  const { id } = req.params;
  await Listing.findByIdAndDelete(id);
  setFlash(req, "success", "Listing deleted successfully.");
  res.redirect("/listings");
});

app.get("/signup", isGuestOnly, (req, res) => {
  res.render("auth/signup");
});

app.post("/signup", isGuestOnly, async (req, res) => {
  const { name, email, password, confirmPassword } = req.body;
  const normalizedEmail = (email || "").toLowerCase().trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name || !normalizedEmail || !password || !confirmPassword) {
    setFlash(req, "error", "All fields are required.");
    return res.redirect("/signup");
  }

  if (!emailRegex.test(normalizedEmail)) {
    setFlash(req, "error", "Please enter a valid email address.");
    return res.redirect("/signup");
  }

  if (password.length < 6) {
    setFlash(req, "error", "Password must be at least 6 characters.");
    return res.redirect("/signup");
  }

  if (password !== confirmPassword) {
    setFlash(req, "error", "Password and confirm password do not match.");
    return res.redirect("/signup");
  }

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    setFlash(req, "error", "Email already registered. Please login.");
    return res.redirect("/login");
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      isEmailVerified: false,
    });
    const emailSent = await createAndSendVerificationToken(req, user);
    if (emailSent) {
      setFlash(req, "success", "Account created. Please verify your email before login.");
    } else {
      setFlash(
        req,
        "error",
        "Account created, but verification email could not be sent. Contact support to configure SMTP."
      );
    }
    res.redirect("/login");
  } catch (error) {
    if (error && error.code === 11000) {
      setFlash(req, "error", "Email already registered. Please login.");
      return res.redirect("/login");
    }
    throw error;
  }
});

app.get("/login", isGuestOnly, (req, res) => {
  res.render("auth/login");
});

app.post("/login", isGuestOnly, async (req, res) => {
  const { email, password, rememberMe } = req.body;
  const user = await User.findOne({ email: (email || "").toLowerCase().trim() });

  if (!user) {
    setFlash(req, "error", "Invalid email or password.");
    return res.redirect("/login");
  }

  if (!user.passwordHash) {
    setFlash(req, "error", "This account uses Google login. Please continue with Google.");
    return res.redirect("/login");
  }

  const isMatch = await bcrypt.compare(password || "", user.passwordHash);
  if (!isMatch) {
    setFlash(req, "error", "Invalid email or password.");
    return res.redirect("/login");
  }

  if (!user.isEmailVerified) {
    setFlash(req, "error", "Please verify your email before logging in.");
    return res.redirect("/login");
  }

  req.session.user = sanitizeSessionUser(user);

  // Keep session for 30 days only when remember me is selected.
  if (rememberMe) {
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  } else {
    req.session.cookie.expires = false;
  }

  setFlash(req, "success", "Logged in successfully.");
  res.redirect("/listings");
});

app.get("/verify-email", async (req, res) => {
  const rawToken = (req.query.token || "").toString().trim();
  if (!rawToken) {
    setFlash(req, "error", "Verification token is missing.");
    return res.redirect("/login");
  }

  const tokenHash = hashToken(rawToken);
  const user = await User.findOne({
    emailVerificationTokenHash: tokenHash,
    emailVerificationExpiresAt: { $gt: new Date() },
  });

  if (!user) {
    setFlash(req, "error", "Verification link is invalid or expired.");
    return res.redirect("/login");
  }

  user.isEmailVerified = true;
  user.emailVerificationTokenHash = null;
  user.emailVerificationExpiresAt = null;
  await user.save();

  setFlash(req, "success", "Email verified successfully. You can now log in.");
  res.redirect("/login");
});

app.post("/resend-verification", isGuestOnly, async (req, res) => {
  const normalizedEmail = (req.body.email || "").toLowerCase().trim();
  if (!normalizedEmail) {
    setFlash(req, "error", "Please provide your email.");
    return res.redirect("/login");
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    setFlash(req, "error", "No account found for this email.");
    return res.redirect("/login");
  }

  if (user.isEmailVerified) {
    setFlash(req, "success", "This email is already verified. Please login.");
    return res.redirect("/login");
  }

  const emailSent = await createAndSendVerificationToken(req, user);
  if (emailSent) {
    setFlash(req, "success", "Verification email sent. Please check your inbox.");
  } else {
    setFlash(req, "error", "Unable to send verification email right now.");
  }
  res.redirect("/login");
});

app.post("/auth/google", isGuestOnly, async (req, res) => {
  try {
    const credential = (req.body.credential || "").toString().trim();
    if (!credential) {
      setFlash(req, "error", "Google credential is missing.");
      return res.redirect("/login");
    }

    const payload = await verifyGoogleCredential(credential);
    const email = (payload?.email || "").toLowerCase().trim();
    const googleId = (payload?.sub || "").toString().trim();
    const name = (payload?.name || email.split("@")[0] || "Google User").trim();

    if (!email || !googleId) {
      setFlash(req, "error", "Google login failed. Missing profile details.");
      return res.redirect("/login");
    }

    if (payload.email_verified !== true) {
      setFlash(req, "error", "Your Google email is not verified.");
      return res.redirect("/login");
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name,
        email,
        googleId,
        isEmailVerified: true,
      });
    } else {
      let changed = false;
      if (!user.googleId) {
        user.googleId = googleId;
        changed = true;
      }
      if (!user.isEmailVerified) {
        user.isEmailVerified = true;
        user.emailVerificationTokenHash = null;
        user.emailVerificationExpiresAt = null;
        changed = true;
      }
      if (changed) await user.save();
    }

    req.session.user = sanitizeSessionUser(user);
    setFlash(req, "success", "Logged in with Google.");
    res.redirect("/listings");
  } catch (error) {
    console.error("Google auth error:", error);
    setFlash(req, "error", "Google login failed. Please try again.");
    res.redirect("/login");
  }
});

app.post("/logout", isLoggedIn, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

app.get("/profile", isLoggedIn, async (req, res) => {
  const user = await User.findById(req.session.user.id);
  if (!user) {
    req.session.user = null;
    setFlash(req, "error", "Please login again.");
    return res.redirect("/login");
  }
  res.render("auth/profile", { user });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Something went wrong.");
});

app.listen(PORT, () => {
  console.log(`StayFinder running at http://localhost:${PORT}`);
});
