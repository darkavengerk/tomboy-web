export interface GpuStatusResponse {
	vram: { total_mb: number; used_mb: number; free_mb: number } | null;
	models: GpuStatusModel[];
	processes: Array<{ pid: number; name: string; vram_mb: number }>;
	ollama_available: boolean;
	ocr_available: boolean;
	gpu_available: boolean;
	fetched_at: string;
}

export interface GpuStatusModel {
	backend: 'ollama' | 'ocr';
	name: string;
	size_mb: number;
	idle_for_s: number | null;
	unloadable: boolean;
}

export interface UnloadRequest {
	backend: 'ollama' | 'ocr';
	name?: string;
}
