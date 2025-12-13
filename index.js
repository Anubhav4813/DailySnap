require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const Parser = require('rss-parser');

const client = new TwitterApi({
    appKey : process.env.X_API_KEY,
    appSecret : process.env.X_API_SECRET,
    accessToken : process.env.X_ACCESS_TOKEN,
    accessSecret : process.env.X_ACCESS_SECRET
});

const rwClient = client.readWrite;

const parser = new Parser();
const RSS_URL = 'https://www.thehindu.com/feeder/default.rss';

async function postNews() {
    try {
        const feed = await parser.parseURL(RSS_URL);
        console.log(`Found ${feed.items.length} items in the feed.`)

        const latestItem = feed.items[0];

        if(latestItem) {
            const tweetText = `${latestItem.title} - ${latestItem.link}`;

            if (tweetText.length <= 280) {
                await rwClient.v2.tweet(tweetText);
                console.log('tweet posted.')
            }
            else {
                console.log('tweet text is too long.')
            }
        }
        else {
            console.log('no new items is found in the array.')
        }
    }
    catch (error) {
        console.error('an error occured in the try except block.', error.message);
    }
}

postNews();