# wav-to-mp3

wav-to-mp3 turns WAV files into MP3s on this computer. Drop files on the page, pick a bitrate, and download one MP3 or the whole batch as a ZIP. The audio never leaves the machine. ffmpeg does the encoding.

The page is in German.

## Run

Install [ffmpeg](https://ffmpeg.org/) with the LAME encoder, then start the page:

```bash
brew install ffmpeg
npm start
```

The app opens `http://127.0.0.1:3847`. It only listens on localhost. Node 20 or newer is required.

Set `PORT` to use another port. Set `OPEN=0` to start without opening the browser.

## What you can do

- Drop one or more `.wav` files, or choose them from disk.
- Encode at 128, 192, 256, or 320 kbps. The default is 192.
- Download a single MP3, or pack every finished file into `mp3s.zip`.
- Clear the list. That also stops a conversion that is still running.

Files larger than 500 MB are refused. A name that appears twice in one ZIP gets a suffix, so the second `Ton.wav` becomes `Ton (2).mp3`.
