import os
import json
import time
import random
import sys
from datetime import datetime, timedelta, timezone

import feedparser
import requests
import tweepy
from dotenv import load_dotenv

# Fix encoding for Windows terminals
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# Load environment variables
load_dotenv()

# Set up simple logging
def print_warn(msg): print(f"[WARN] {msg}")
def print_err(msg): print(f"[ERROR] {msg}")
def print_info(msg): print(f"[INFO] {msg}")
def print_success(msg): print(f"✅ {msg}")

DRY_RUN = os.environ.get('DRY_RUN') in ['1', 'true']

# Twitter Client initialization
client = tweepy.Client(
    bearer_token=os.environ.get('X_BEARER_TOKEN'),
    consumer_key=os.environ.get('X_API_KEY'),
    consumer_secret=os.environ.get('X_API_SECRET'),
    access_token=os.environ.get('X_ACCESS_TOKEN'),
    access_token_secret=os.environ.get('X_ACCESS_SECRET')
)

auth = tweepy.OAuth1UserHandler(
    os.environ.get('X_API_KEY'),
    os.environ.get('X_API_SECRET'),
    os.environ.get('X_ACCESS_TOKEN'),
    os.environ.get('X_ACCESS_SECRET')
)
api_v1 = tweepy.API(auth)

rss_feeds = [
    "https://www.thehindu.com/news/national/feeder/default.rss",
    "https://indianexpress.com/section/india/feed/",
    "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
    "https://techcrunch.com/feed/",
]

# Persistence
POSTED_LINKS_FILE = 'posted_links.json'
posted_links_set = set()

def load_posted_links():
    global posted_links_set
    try:
        if os.path.exists(POSTED_LINKS_FILE):
            with open(POSTED_LINKS_FILE, 'r') as f:
                arr = json.load(f)
                if isinstance(arr, list):
                    posted_links_set = set(arr[-1000:])
            print_info(f"Loaded {len(posted_links_set)} posted links.")
    except Exception as e:
        print_err(f"Failed to load posted links: {e}")

def save_posted_links():
    try:
        with open(POSTED_LINKS_FILE, 'w') as f:
            json.dump(list(posted_links_set), f, indent=2)
    except Exception as e:
        print_err(f"Failed to save posted links: {e}")

def fetch_feed_with_retry(feed_url, retries=2):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    }
    for attempt in range(retries):
        try:
            resp = requests.get(feed_url, headers=headers, timeout=10)
            resp.raise_for_status()
            feed = feedparser.parse(resp.content)
            if feed.entries: return feed.entries
        except:
            time.sleep(1)
    return []



def extract_media_from_item(item):
    try:
        if 'media_content' in item and item.media_content:
            url = item.media_content[0].get('url', '')
            if any(ext in url.lower() for ext in ['.jpg', '.png']): return {'type': 'image', 'url': url}
            if any(ext in url.lower() for ext in ['.mp4', '.webm']): return {'type': 'video', 'url': url}
    except:
        pass
    return None

def post_tweet(text, media=None):
    if DRY_RUN:
        print(f'[DRY_RUN] Tweet: {text}')
        return True
        
    try:
        media_ids = []
        if media and media['url']:
            resp = requests.get(media['url'], timeout=30)
            ext = 'mp4' if media['type'] == 'video' else 'jpg'
            temp_file = f"temp.{ext}"
            with open(temp_file, 'wb') as f: f.write(resp.content)
            
            media_info = api_v1.media_upload(filename=temp_file)
            media_ids.append(media_info.media_id)
            os.remove(temp_file)
            time.sleep(2)
            
        if media_ids:
            client.create_tweet(text=text, media_ids=media_ids)
        else:
            client.create_tweet(text=text)
        print_success("Tweet posted successfully!")
        return True
    except Exception as e:
        import traceback
        traceback.print_exc()
        print_err(f"Failed to post tweet: {e}")
        return False

def process_one_tweet():
    for feed_url in rss_feeds:
        items = fetch_feed_with_retry(feed_url, 1)
        for item in items[:5]: # Look at top 5 items per feed
            link = item.get('link') or item.get('guid')
            if not link or link in posted_links_set: continue
            
            title = item.get('title')
            if not title: continue
            
            tweet_text = f"{title}\n\n{link}"
            
            media = extract_media_from_item(item)
            
            print(f"\n📌 Posting: {title}")
            print(f"🔗 Link: {link}")
            
            if post_tweet(tweet_text, media):
                posted_links_set.add(link)
                save_posted_links()
                return True
                
    print_warn("No new articles to post.")
    return False

if __name__ == '__main__':
    print("🚀 Starting simple news bot...")
    load_posted_links()
    process_one_tweet()
    print("🏁 Finished")
