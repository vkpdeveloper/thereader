export interface Book {
  id: string;
  version: string;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
  coverId: string | null;
  coverUrl: string | null;
  downloadUrl: string;
  fileSize: number;
  sha256: string;
  updatedAt: string;
}

export interface ReadingProgress {
  cfi: string | null;
  totalProgression: number;
  title?: string;
  updatedAt: number;
}

export interface LibraryEntry {
  id: string;
  book: Book;
  downloaded: boolean;
  progress?: ReadingProgress;
  addedAt: number;
}

export interface AppSettings {
  apiBaseUrl: string;
  themeId: string;
}
