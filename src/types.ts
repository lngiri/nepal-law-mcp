export type TextQuality = "unprocessed" | "verified" | "low_confidence" | "error";

export interface Statute {
  id: number;
  title_np: string;
  title_en: string;
  year: string | null;
  status: "in_force" | "repealed" | "unknown";
  source_url: string | null;
  quality: TextQuality;
  quality_detail: string | null;
}

export type NewStatute = Omit<Statute, "id" | "quality" | "quality_detail">;

export interface Provision {
  id: number;
  statute_id: number;
  section_number: string | null;
  section_title: string | null;
  text: string;
}

export interface ScrapedAct {
  title_np: string;
  title_en: string;
  year: string | null;
  status: "in_force" | "repealed" | "unknown";
  source_url: string | null;
  provisions: ScrapedProvision[];
}

export interface ScrapedProvision {
  section_number: string | null;
  section_title: string | null;
  text: string;
}

export interface SearchResult {
  statute_id: number;
  title_np: string;
  title_en: string;
  snippet: string;
  rank: number;
  quality: TextQuality;
}
