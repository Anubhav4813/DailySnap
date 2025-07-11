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
const MAX_RETRIES = 3;

const twitterClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET
});
const rwClient = twitterClient.readWrite;

const rssFeeds = [
  "https://www.thehindu.com/news/national/feeder/default.rss",
  "https://indianexpress.com/section/india/feed/"
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

// Extract image or video from RSS item - IMPROVED
function extractMediaFromItem(item) {
  try {
    console.log(`[DEBUG] Extracting media from item: ${item.title}`);

    // Check enclosure (most common for RSS)
    if (item.enclosure && item.enclosure.url) {
      console.log(`[DEBUG] Found enclosure: ${item.enclosure.url}, type: ${item.enclosure.type}`);
      if (item.enclosure.type && item.enclosure.type.startsWith('image/')) {
        return { type: 'image', url: item.enclosure.url };
      }
      if (item.enclosure.type && item.enclosure.type.startsWith('video/')) {
        return { type: 'video', url: item.enclosure.url };
      }
    }

    // Check media:content
    if (item['media:content']) {
      let mediaContent = item['media:content'];
      // Handle array of media content
      if (Array.isArray(mediaContent)) {
        mediaContent = mediaContent[0];
      }

      if (mediaContent && mediaContent.$ && mediaContent.$.url) {
        console.log(`[DEBUG] Found media:content: ${mediaContent.$.url}, type: ${mediaContent.$.type}`);
        const mediaType = mediaContent.$.type || '';
        
        // If type is specified, use it
        if (mediaType.startsWith('image/')) {
          return { type: 'image', url: mediaContent.$.url };
        }
        if (mediaType.startsWith('video/')) {
          return { type: 'video', url: mediaContent.$.url };
        }
        
        // If no type specified, guess from URL extension
        const url = mediaContent.$.url;
        const ext = url.split('.').pop().toLowerCase().split('?')[0];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        const videoExts = ['mp4', 'mov', 'webm', 'avi'];
        
        if (imageExts.includes(ext)) {
          console.log(`[DEBUG] Detected image from extension: ${ext}`);
          return { type: 'image', url: url };
        }
        if (videoExts.includes(ext)) {
          console.log(`[DEBUG] Detected video from extension: ${ext}`);
          return { type: 'video', url: url };
        }
      }
    }

    // Parse HTML content for images/videos
    const contentToSearch = item['content:encoded'] || item.content || item.description || '';
    if (contentToSearch) {
      // Look for video tags
      const videoMatch = contentToSearch.match(/<video[^>]+src\s*=\s*['"](.*?)['"][^>]*>/i);
      if (videoMatch) {
        console.log(`[DEBUG] Found video in content: ${videoMatch[1]}`);
        return { type: 'video', url: videoMatch[1] };
      }

      // Look for img tags
      const imgMatch = contentToSearch.match(/<img[^>]+src\s*=\s*['"](.*?)['"][^>]*>/i);
      if (imgMatch) {
        console.log(`[DEBUG] Found image in content: ${imgMatch[1]}`);
        return { type: 'image', url: imgMatch[1] };
      }
    }

    // Check if there's a thumbnail or image URL in other fields
    if (item.image && item.image.url) {
      console.log(`[DEBUG] Found image URL: ${item.image.url}`);
      return { type: 'image', url: item.image.url };
    }

    console.log(`[DEBUG] No media found for: ${item.title}`);
    return null;
  } catch (err) {
    console.error('Error extracting media from item:', err.message);
    return null;
  }
}

// Validate and clean media URL
function validateMediaUrl(url) {
  try {
    if (!url) return null;

    // Remove tracking parameters and clean URL
    const cleanUrl = url.split('?')[0];

    // Check if it's a valid image/video extension
    const ext = cleanUrl.split('.').pop().toLowerCase();
    const validImageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const validVideoExts = ['mp4', 'mov', 'webm', 'avi'];

    if (validImageExts.includes(ext)) {
      return { type: 'image', url: cleanUrl };
    }
    if (validVideoExts.includes(ext)) {
      return { type: 'video', url: cleanUrl };
    }

    // If no clear extension but URL looks like media, try to determine type from content
    if (url.includes('/images/') || url.includes('/img/') || url.includes('image') || url.includes('.jpg') || url.includes('.png') || url.includes('.jpeg')) {
      return { type: 'image', url: url };
    }
    
    if (url.includes('/videos/') || url.includes('/video/') || url.includes('.mp4') || url.includes('.webm')) {
      return { type: 'video', url: url };
    }

    return null;
  } catch (err) {
    console.error('Error validating media URL:', err.message);
    return null;
  }
}

// Post tweet with image or video support - IMPROVED
async function postTweet(text, media) {
  const mimeFromExt = (url) => {
    if (!url) return null;
    const ext = url.split('.').pop().toLowerCase().split('?')[0];
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'webm': 'video/webm'
    };
    return mimeTypes[ext] || null;
  };

  const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideoTypes = ['video/mp4', 'video/quicktime', 'video/webm'];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let mediaIds = [];

      if (media && media.url) {
        try {
          console.log(`[DEBUG] Attempting to download media: ${media.url}`);

          // Download media with proper headers
          const response = await axios.get(media.url, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'image/*, video/*',
              'Referer': 'https://google.com'
            },
            timeout: 30000,
            maxContentLength: 5 * 1024 * 1024, // 5MB limit
            maxRedirects: 5
          });

          const buffer = Buffer.from(response.data);
          const contentType = response.headers['content-type'] || '';
          const detectedMime = mimeFromExt(media.url);

          console.log(`[DEBUG] Downloaded ${buffer.length} bytes, content-type: ${contentType}, detected mime: ${detectedMime}`);

          // Use detected mime type or fallback to content-type
          const mimeType = detectedMime || contentType;

          if (media.type === 'image') {
            if (allowedImageTypes.includes(mimeType) || allowedImageTypes.includes(contentType)) {
              console.log(`[DEBUG] Uploading image with mime type: ${mimeType}`);
              const mediaId = await rwClient.v1.uploadMedia(buffer, { mimeType: mimeType || 'image/jpeg' });
              mediaIds.push(mediaId);
              console.log(`[DEBUG] Successfully uploaded image, mediaId: ${mediaId}`);
            } else {
              console.warn(`[WARN] Unsupported image type: ${mimeType} / ${contentType}, trying as jpeg`);
              // Try uploading as JPEG if mime type detection fails
              try {
                const mediaId = await rwClient.v1.uploadMedia(buffer, { mimeType: 'image/jpeg' });
                mediaIds.push(mediaId);
                console.log(`[DEBUG] Successfully uploaded image as JPEG, mediaId: ${mediaId}`);
              } catch (fallbackError) {
                console.error(`[ERROR] Failed to upload as JPEG: ${fallbackError.message}`);
              }
            }
          } else if (media.type === 'video') {
            if (allowedVideoTypes.includes(mimeType) || allowedVideoTypes.includes(contentType)) {
              console.log(`[DEBUG] Uploading video with mime type: ${mimeType}`);
              const mediaId = await rwClient.v1.uploadMedia(buffer, { mimeType: mimeType || 'video/mp4' });
              mediaIds.push(mediaId);
              console.log(`[DEBUG] Successfully uploaded video, mediaId: ${mediaId}`);
            } else {
              console.warn(`[WARN] Unsupported video type: ${mimeType} / ${contentType}`);
            }
          }
        } catch (mediaError) {
          console.error(`[ERROR] Failed to process media: ${mediaError.message}`);
          // Continue without media
        }
      }

      // Post tweet
      const tweetData = {
        text
      };

      if (mediaIds.length > 0) {
        tweetData.media = { media_ids: mediaIds };
        // Small delay after media upload to ensure it's processed
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const { data } = await rwClient.v2.tweet(tweetData);

      if (mediaIds.length > 0) {
        console.log(`✅ Tweet with ${media.type} posted: https://twitter.com/user/status/${data.id}`);
      } else {
        console.log(`✅ Text-only tweet posted: https://twitter.com/user/status/${data.id}`);
      }

      return true;

    } catch (error) {
      console.error(`❌ Failed to post tweet (Attempt ${attempt}):`, error.message);

      if (error.response && error.response.data) {
        console.error('[DEBUG] Twitter API error:', JSON.stringify(error.response.data, null, 2));
      }

      // Handle rate limiting
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 60;
        console.log(`⏳ Rate limited. Waiting ${retryAfter} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt < MAX_RETRIES) {
        console.log(`🔄 Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  console.error("❌ All tweet attempts failed.");
  return false;
}

// Track posted article links persistently
const POSTED_LINKS_FILE = 'posted_links.json';
let postedLinks = new Set();

// Load posted links from file
function loadPostedLinks() {
  try {
    if (fs.existsSync(POSTED_LINKS_FILE)) {
      const data = fs.readFileSync(POSTED_LINKS_FILE, 'utf-8');
      const arr = JSON.parse(data);
      postedLinks = new Set(arr);
      
      // Clean old links (keep only last 1000 to avoid memory issues)
      if (postedLinks.size > 1000) {
        const linksArray = Array.from(postedLinks);
        postedLinks = new Set(linksArray.slice(-1000));
        savePostedLinks();
      }
      
      console.log(`[DEBUG] Loaded ${postedLinks.size} posted links from file.`);
    }
  } catch (err) {
    console.error('[DEBUG] Failed to load posted links:', err.message);
  }
}

// Save posted links to file
function savePostedLinks() {
  try {
    fs.writeFileSync(POSTED_LINKS_FILE, JSON.stringify(Array.from(postedLinks), null, 2));
    console.log(`[DEBUG] Saved ${postedLinks.size} posted links to file.`);
  } catch (err) {
    console.error('[DEBUG] Failed to save posted links:', err.message);
  }
}

async function processOneTweet() {
  try {
    let allArticles = [];

    // Fetch and collect articles from all feeds
    for (const feedUrl of rssFeeds) {
      try {
        console.log(`[DEBUG] Fetching feed: ${feedUrl}`);
        const response = await axios.get(feedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000
        });
        const feed = await parser.parseString(response.data);
        console.log(`[DEBUG] Found ${feed.items.length} items in feed`);
        allArticles.push(...feed.items.slice(0, 5));
      } catch (err) {
        console.error(`❌ Failed to fetch or parse feed: ${feedUrl} - ${err.message}`);
      }
    }

    if (allArticles.length === 0) {
      console.log("⚠️ No articles found.");
      return false;
    }

    console.log(`[DEBUG] Total articles collected: ${allArticles.length}`);

    // Score all articles for general news, sort by score descending
    let scoredArticles = [];
    for (const item of allArticles) {
      let content = item['content:encoded'] || item.content;
      if (!content || content.length < 300) {
        content = await extractArticleContent(item.link);
      }
      if (!content || content.length < 300) continue;

      // Extract and validate media
      const rawMedia = extractMediaFromItem(item);
      const media = rawMedia ? validateMediaUrl(rawMedia.url) : null;

      if (media) {
        console.log(`[DEBUG] Valid media found for "${item.title}": ${media.type} - ${media.url}`);
      } else if (rawMedia) {
        console.log(`[DEBUG] Raw media found but validation failed for "${item.title}": ${rawMedia.url}`);
      }

      // Score using local keyword method
      const keywords = [
        "breaking", "exclusive", "alert", "major", "govt", "government", "india", "supreme court",
        "prime minister", "parliament", "election", "crisis", "emergency", "policy", "law", "verdict",
        "protest", "violence", "death", "attack", "arrest", "ban", "strike", "budget", "cabinet",
        "minister", "president", "chief", "top", "big", "important", "significant", "historic",
        "landmark", "record", "highest", "lowest", "first time", "last", "new", "update", "decision"
      ];

      let keywordScore = 0;
      const lowerContent = content.toLowerCase();
      for (const kw of keywords) {
        if (lowerContent.includes(kw)) keywordScore++;
      }

      // Boost score based on media type priority: videos > images > text-only
      let score = keywordScore;
      if (media) {
        if (media.type === 'video') {
          score += 5; // Highest priority for videos
        } else if (media.type === 'image') {
          score += 3; // Medium priority for images
        }
      }
      // Text-only articles get no media boost (score = keywordScore only)

      scoredArticles.push({ item, score, media });
    }

    // Sort by score descending, then by media type priority (video > image > text-only)
    scoredArticles.sort((a, b) => {
      // First sort by score
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      
      // If scores are equal, prioritize by media type
      const getMediaPriority = (media) => {
        if (!media) return 0; // text-only
        if (media.type === 'video') return 3;
        if (media.type === 'image') return 2;
        return 1;
      };
      
      return getMediaPriority(b.media) - getMediaPriority(a.media);
    });
    console.log(`[DEBUG] Scored ${scoredArticles.length} articles`);
    
    // Show top 3 articles with their scores for debugging
    console.log(`[DEBUG] Top articles by priority:`);
    for (let i = 0; i < Math.min(3, scoredArticles.length); i++) {
      const { item, score, media } = scoredArticles[i];
      const mediaInfo = media ? `${media.type}` : 'text-only';
      console.log(`[DEBUG] ${i + 1}. Score: ${score} | Media: ${mediaInfo} | "${item.title.substring(0, 60)}..."`);
    }

    // Try each article in order of priority
    let fallbackArticle = null;
    let fallbackSummary = null;
    let fallbackLink = null;

    for (let i = 0; i < Math.min(scoredArticles.length, 5); i++) {
      const { item, score, media } = scoredArticles[i];
      const link = item.link || item.guid;

      if (!link || postedLinks.has(link)) {
        console.log(`[DEBUG] Skipping already posted article: ${item.title}`);
        continue;
      }

      let content = item['content:encoded'] || item.content;
      if (!content || content.length < 300) {
        content = await extractArticleContent(item.link);
      }
      if (!content || content.length < 300) continue;

      let summary = null;
      // Try Gemini summary for videos (highest priority), top 3 articles, or articles with media
      if ((media && media.type === 'video') || i < 3 || media) {
        try {
          console.log(`[DEBUG] Generating Gemini summary for article ${i + 1} (score: ${score}, media: ${media ? media.type : 'none'})`);
          summary = await generateStrictLengthSummary(content);
        } catch (err) {
          console.error(`[ERROR] Failed to generate summary: ${err.message}`);
          // Fallback to simple summary
          summary = content.replace(/\s+/g, ' ').trim().substring(0, 277);
          if (summary.length > 277) summary = summary.substring(0, 277) + '...';
        }
      } else {
        // Fallback: use first 260-280 chars of content
        summary = content.replace(/\s+/g, ' ').trim().substring(0, 277);
        if (summary.length > 277) summary = summary.substring(0, 277) + '...';
      }

      if (!summary) continue;

      // Save the first eligible article as fallback
      if (!fallbackArticle) {
        fallbackArticle = item;
        fallbackSummary = summary;
        fallbackLink = link;
      }

      // Post the news
      console.log(`\n📌 Posting article (score: ${score}): ${item.title}`);
      console.log(`📝 Summary: ${summary}`);
      console.log(`📏 Length: ${summary.length}/280`);
      if (media) {
        console.log(`🖼️ Media: ${media.type} - ${media.url}`);
      }

      const success = await postTweet(summary, media);
      if (success) {
        postedLinks.add(link);
        savePostedLinks();
        return true;
      }
    }

    // Fallback to highest-priority article as text-only
    if (fallbackArticle && fallbackSummary && fallbackLink) {
      console.log("⚠️ Posting highest-priority article as text-only fallback.");
      const success = await postTweet(fallbackSummary, null);
      if (success) {
        postedLinks.add(fallbackLink);
        savePostedLinks();
        return true;
      }
    }

    console.log("⚠️ No suitable article found for tweeting.");
    return false;
  } catch (err) {
    console.error("❌ Error in processOneTweet:", err.message);
    return false;
  }
}

async function processUntilTweetPosted(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n🌀 Overall Attempt ${attempt} to post tweet...`);
    const success = await processOneTweet();
    if (success) return;
    if (attempt < maxAttempts) {
      console.log("🔁 Retrying in 5 seconds...");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log("❌ All attempts to post tweet failed.");
}

(async () => {
  console.log("🚀 Starting scheduled summarizer...");
  loadPostedLinks();
  await processUntilTweetPosted(3);
  console.log("🏁 Finished");
})();