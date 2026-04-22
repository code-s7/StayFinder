const mongoose = require("mongoose");
const Listing = require("./models/listing");

const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/stayfinder";

const sampleListings = [
  {
    title: "Student Room near University",
    description: "Affordable single room with Wi-Fi and study table.",
    price: 6000,
    category: "room-hostel-pg",
    imageUrl: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1000&q=80",
    location: "Allahabad",
  },
  {
    title: "Startup Office Space",
    description: "Modern office for 8-10 people with meeting room access.",
    price: 28000,
    category: "office",
    imageUrl: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1000&q=80",
    location: "Noida",
  },
  {
    title: "Main Road Retail Shop",
    description: "High-footfall area suitable for grocery or apparel store.",
    price: 18000,
    category: "shop",
    imageUrl: "https://images.unsplash.com/photo-1604719312566-8912e9c8a213?auto=format&fit=crop&w=1000&q=80",
    location: "Lucknow",
  },
];

async function seedDB() {
  await mongoose.connect(MONGO_URL);
  await Listing.deleteMany({});
  await Listing.insertMany(sampleListings);
  console.log("Sample listings inserted.");
  await mongoose.connection.close();
}

seedDB().catch((err) => {
  console.error(err);
  mongoose.connection.close();
});
