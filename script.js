// test script
require('dotenv').config();
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { TwitterApi } = require('twitter-api-v2');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
const MIN_SUMMARY_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 280;

const twitterClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET
});
const rwClient = twitterClient.readWrite;

const rssFeeds = [
  "https://www.hindustantimes.com/feeds/rss/latest/rssfeed.xml",
  "https://feeds.feedburner.com/ndtvnews-top-stories",
  "https://indianexpress.com/section/india/feed/",
  "https://www.thehindu.com/news/national/feeder/default.rss"
];

const parser = new Parser({
  customFields: {
    item: ['content:encoded', 'media:content']
  }
});

async function extractArticleContent(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });

    const $ = cheerio.load(data);
    $('script, style, iframe, noscript, figure, .ad-container').remove();

    if (url.includes('thehindu.com')) {
      return $('[itemprop="articleBody"]').text().trim();
    } else if (url.includes('indianexpress.com')) {
      return $('.full-details, .editor-body').text().trim();
    } else {
      return $('article, .article-content, [itemprop="articleBody"]').text().trim() ||
        $('body').text().trim();
    }
  } catch (error) {
    console.error(`Error extracting content from ${url}:`, error.message);
    return null;
  }
}

async function generateStrictLengthSummary(content) {
  try {
    const truncatedContent = content.substring(0, 10000);
    const prompt = {
      contents: [{
        parts: [{
          text: `Summarize this news article in exactly 260 characters (no less than 240, no more than 280).\nInclude key details: who, what, where, when, why.\nMaintain complete sentences and proper grammar.\nNo hashtags or emojis. Be factual and concise.\n\nArticle: ${truncatedContent}`
        }]
      }]
    };

    const response = await axios.post(GEMINI_ENDPOINT, prompt, {
      headers: { 'Content-Type': 'application/json' }
    });

    let summary = response.data.candidates[0].content.parts[0].text;

    if (summary.length < MIN_SUMMARY_LENGTH) {
      return await generateStrictLengthSummary(content);
    }

    if (summary.length > MAX_SUMMARY_LENGTH) {
      summary = summary.substring(0, MAX_SUMMARY_LENGTH - 3) + '...';
    }

    return summary;
  } catch (error) {
    console.error("Gemini API error:", error.response?.data || error.message);
    return null;
  }
}

function extractImageFromItem(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item['media:content'] && item['media:content']['$']?.url) return item['media:content']['$'].url;
  const match = item.content?.match(/<img[^>]+src=\"([^">]+)\"/);
  return match ? match[1] : null;
}

async function postTweet(text, imageUrl) {
  try {
    let mediaId = null;

    if (imageUrl) {
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(response.data, 'binary');
      mediaId = await rwClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });
    }

    const { data } = await rwClient.v2.tweet({
      text,
      media: mediaId ? { media_ids: [mediaId] } : undefined,
    });

    console.log(`✅ Tweet posted: https://twitter.com/user/status/${data.id}`);
  } catch (error) {
    console.error("❌ Failed to post tweet:", error.message);
  }
}

async function processOneTweet() {
  try {
    let allArticles = [];

    for (const feedUrl of rssFeeds) {
      const feed = await parser.parseURL(feedUrl);
      allArticles.push(...feed.items.slice(0, 3));
    }

    if (allArticles.length === 0) {
      console.log("⚠️ No articles found.");
      return;
    }

    const item = allArticles[Math.floor(Math.random() * allArticles.length)];
    console.log(`\n📌 Title: ${item.title}`);

    let content = item['content:encoded'] || item.content;
    if (!content || content.length < 300) {
      console.log("⚡ Fetching full article content...");
      content = await extractArticleContent(item.link);
    }

    if (content && content.length > 300) {
      const summary = await generateStrictLengthSummary(content);
      if (!summary) {
        console.log("⚠️ Summary generation failed.");
        return;
      }

      const tweet = summary;
      const imageUrl = extractImageFromItem(item);

      console.log("\n🐦 Tweet-ready content:");
      console.log(tweet);
      console.log(`Length: ${tweet.length}/280`);

      await postTweet(tweet, imageUrl);
    } else {
      console.log("⚠️ Article too short for summarization.");
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

(async () => {
  console.log("🚀 Starting scheduled summarizer...");
  await processOneTweet();
  console.log("✅ Done (1 tweet posted)");
})();
