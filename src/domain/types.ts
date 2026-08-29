export interface CountValue {
  raw: string;
  value: number | null;
}

export interface ProfileRecord {
  profileUrl: string;
  accountName: string;
  redId: string;
  avatarUrl: string;
  description: string;
  ipLocation: string;
  following: CountValue;
  followers: CountValue;
  likedAndCollected: CountValue;
  collectedAt: string;
  exportNotes: string[];
}

export type NoteType = 'image' | 'video' | 'unknown';

export interface NoteRecord {
  id: string;
  title: string;
  noteUrl: string;
  type: NoteType;
  likes: CountValue;
  coverUrl: string;
  exportNotes: string[];
}

export interface CollectionResult {
  profile: ProfileRecord;
  notes: NoteRecord[];
}

export type CollectionPhase = 'ready' | 'collecting' | 'complete' | 'paused' | 'failed';
