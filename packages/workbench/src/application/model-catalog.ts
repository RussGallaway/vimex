export interface AvailableModel { id: string; label: string; efforts: readonly string[] }
export interface ModelCatalog { listModels(): Promise<readonly AvailableModel[]> }
