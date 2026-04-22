const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const session = require("express-session");
const bcrypt = require("bcryptjs");
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

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
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

app.use((req, res, next) => {
  res.locals.navCategories = NAV_CATEGORIES;
  res.locals.selectedCategory = "all";
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.get("/", (req, res) => {
  res.redirect("/listings");
});

app.get("/listings", async (req, res) => {
  const selectedCategory = req.query.category || "all";
  const city = (req.query.city || "").trim();
  res.locals.selectedCategory = selectedCategory;
  res.locals.searchCity = city;
  let query = {};
  if (selectedCategory === "room-hostel-pg") {
    query = { category: { $in: ["room-hostel-pg", "room"] } };
  } else if (selectedCategory !== "all") {
    query = { category: selectedCategory };
  }
  if (city) {
    query.location = { $regex: city, $options: "i" };
  }
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

app.post("/listings", isLoggedIn, async (req, res) => {
  const listing = new Listing(req.body.listing);
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
  res.render("listings/show", { listing });
});

app.get("/listings/:id/edit", async (req, res) => {
  if (!req.session.user) {
    setFlash(req, "error", "Please login to edit listings.");
    return res.redirect("/login");
  }
  const { id } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    return res.status(404).send("Listing not found");
  }
  res.render("listings/edit", { listing });
});

app.put("/listings/:id", isLoggedIn, async (req, res) => {
  const { id } = req.params;
  await Listing.findByIdAndUpdate(id, req.body.listing, {
    new: true,
    runValidators: true,
  });
  setFlash(req, "success", "Listing updated successfully.");
  res.redirect(`/listings/${id}`);
});

app.delete("/listings/:id", isLoggedIn, async (req, res) => {
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

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash,
  });

  req.session.user = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
  };
  res.redirect("/listings");
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

  const isMatch = await bcrypt.compare(password || "", user.passwordHash);
  if (!isMatch) {
    setFlash(req, "error", "Invalid email or password.");
    return res.redirect("/login");
  }

  req.session.user = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
  };

  // Keep session for 30 days only when remember me is selected.
  if (rememberMe) {
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  } else {
    req.session.cookie.expires = false;
  }

  setFlash(req, "success", "Logged in successfully.");
  res.redirect("/listings");
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
