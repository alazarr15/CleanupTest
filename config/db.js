const mongoose = require("mongoose");

// Use the exact environment variable you set in CapRover
const mongoUri = process.env.MONGODB_URI;

console.log("Mongo URI loaded from environment inside dbjs:", mongoUri);

const connectDB = async () => {
    try {
        await mongoose.connect(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log("MongoDB connected");
    } catch (err) {
        console.error("MongoDB connection error:", err);
        process.exit(1); // stop the app if DB connection fails
    }
};

module.exports = connectDB;
