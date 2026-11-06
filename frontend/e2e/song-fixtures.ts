import type { SongMatch } from '../src/api';

// Controlled catalog metadata and synthetic artwork, not provider-quality proof.
export const songVersions: SongMatch[] = [
  { title: 'First Love', artists: ['Hikaru Utada'], duration_seconds: 258,
    url: 'https://music.youtube.com/watch?v=o1sUaVJUeB0',
    thumbnail_url: 'https://i.ytimg.com/vi/o1sUaVJUeB0/default.jpg', play_count: 2700000000, play_count_approximate: true },
  { title: 'First Love (Dance Remix)', artists: ['Hikaru Utada'], duration_seconds: 305,
    url: 'https://music.youtube.com/watch?v=remix123456', thumbnail_url: null, play_count: 0, play_count_approximate: false },
  { title: 'First Love (Live)', artists: ['Hikaru Utada'], duration_seconds: null,
    url: 'https://music.youtube.com/watch?v=live1234567',
    thumbnail_url: 'https://i.ytimg.com/vi/live1234567/default.jpg', play_count: null, play_count_approximate: false },
];
export const songArtwork = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="#233a4f"/><circle cx="48" cy="48" r="30" fill="#b9cd83"/><circle cx="48" cy="48" r="12" fill="#233a4f"/></svg>';
