export interface AccountView {
  id: string;
  uid: string;
  nickname: string;
  avatarUrl: string;
  vipType: string;
  vipExpireAt?: number | null;
  isVip: boolean;
  totalSpace: number;
  usedSpace: number;
  lastCheckAt?: number | null;
}

export interface FileView {
  fid: string;
  parentFid: string;
  name: string;
  isDir: boolean;
  size: number;
  category: number;
  formatType: string;
  updatedAt: number;
  thumbnail: string;
}

export interface ListResult {
  entries: FileView[];
  total: number;
  page: number;
  size: number;
}

export interface RecycleView {
  recordId: string;
  fid: string;
  name: string;
  isDir: boolean;
  size: number;
  category: number;
  formatType: string;
  parentFid: string;
  deletedAt: number;
  updatedAt: number;
}

export interface RecycleListResult {
  entries: RecycleView[];
  total: number;
  page: number;
  size: number;
}

export interface TransferView {
  id: string;
  accountId: string;
  kind: string;
  status: string;
  phase: string;
  fid?: string | null;
  localPath: string;
  remoteName: string;
  remoteParentFid: string;
  totalBytes: number;
  doneBytes: number;
  speedBps: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VolumeView {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  writable: boolean;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageRoot {
  name: string;
  path: string;
  isRemovable: boolean;
  totalBytes: number;
  freeBytes: number;
  writable: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  totalBytes: number;
  freeBytes: number;
  writable: boolean;
  isRoot: boolean;
}

export interface StorageRoots {
  roots: StorageRoot[];
  home: string;
}

export interface FileBrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

export interface FileBrowseResult {
  path: string;
  parent: string | null;
  entries: FileBrowseEntry[];
  totalBytes: number;
  freeBytes: number;
  writable: boolean;
  isRoot: boolean;
}

export interface AuthStatus {
  registered: boolean;
  authenticated: boolean;
  lanAllowed?: boolean;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  target: string;
  message: string;
}

export interface LogsResult {
  entries: LogEntry[];
  total: number;
}

export interface ServerInfo {
  cpuUsagePercent: number;
  cpuCores: number;
  cpuBrand: string;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  networkReceivedBps: number;
  networkTransmittedBps: number;
  networkTotalReceivedBytes: number;
  networkTotalTransmittedBytes: number;
  uptimeSeconds: number;
  osName: string;
  osVersion: string;
  hostName: string;
}

export interface Settings {
  downloadDir: string;
  concurrency: number;
  maxSpeedBps: number;
  theme: string;
  lanOnly?: boolean;
  fnosMode?: boolean;
}

export interface Bootstrap {
  accounts: AccountView[];
  settings: Settings;
  transfers: TransferView[];
  defaultParentFid: string;
  dataDir: string;
  volumes: VolumeView[];
}

export interface QrLoginStart {
  sessionId: string;
  qrUrl: string;
  expiresAt: number;
}

export interface QrLoginPoll {
  state: 'waiting' | 'expired' | 'success';
  expiresAt?: number;
  account?: AccountView;
  message?: string;
}

export interface DownloadItem {
  fid: string;
  name?: string;
  size?: number;
  isDir?: boolean;
}

export interface CoreEvent {
  type: string;
  [key: string]: unknown;
}

export interface GpuInfo {
  vendor: string;
  vendorLabel: string;
  name: string;
  driver?: string | null;
  bus?: string | null;
  renderDevices: string[];
}

export interface HwImpl {
  name: string;
  accel: string;
  vendor: string;
  vendorLabel: string;
}

export interface CodecImpls {
  software: string[];
  hardware: HwImpl[];
}

export interface CodecSupport {
  codec: string;
  label: string;
  decode: CodecImpls;
  encode: CodecImpls;
}

export interface HwDevice {
  accel: string;
  label: string;
  vendor: string;
  vendorLabel: string;
  device?: string | null;
  available: boolean;
  declared: boolean;
  verified?: boolean | null;
  note?: string | null;
}

export interface PathCandidate {
  path: string;
  source: string;
  exists: boolean;
}

export interface InstallHint {
  label: string;
  command: string;
  note?: string | null;
}

export interface TranscodeStatus {
  platform: string;
  arch: string;
  found: boolean;
  path?: string | null;
  source: string;
  ffprobePath?: string | null;
  version?: string | null;
  buildConfig: string[];
  hwaccels: string[];
  gpus: GpuInfo[];
  devices: HwDevice[];
  codecs: CodecSupport[];
  candidates: PathCandidate[];
  install: InstallHint[];
  checkedAt: number;
  probeMs: number;
  error?: string | null;
}

export interface MediaFile {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  container: string;
  durationMs: number;
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  videoBitrateBps: number;
  pixFmt: string;
  bitDepth: number;
  isHdr: boolean;
  audioCodec?: string | null;
  audioChannels: number;
  subtitleCount: number;
}

export interface ScanResult {
  directory: string;
  scanned: number;
  matched: number;
  skippedBySize: number;
  files: MediaFile[];
  errors: string[];
  tookMs: number;
}

export interface ScanProgress {
  running: boolean;
  directory: string;
  processed: number;
  total: number;
  matched: number;
  errors: number;
  skippedBySize: number;
  cacheHits: number;
  startedAt: number;
  finishedAt?: number | null;
  tookMs: number;
  error?: string | null;
}

export interface QueueState {
  paused: boolean;
  running: number;
  queued: number;
}

export interface JobView {
  id: string;
  sourcePath: string;
  sourceName: string;
  outputPath: string;
  sourceCodec: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  sourceBitrateKbps: number;
  targetCodec: string;
  container: string;
  resolution: string;
  encoder: string;
  hardware: boolean;
  accel?: string | null;
  vendor?: string | null;
  bitrateKbps: number;
  quality?: string | null;
  audio: string;
  deleteOriginal: boolean;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled' | string;
  progress: number;
  durationMs: number;
  outTimeMs: number;
  speed?: number | null;
  fps?: number | null;
  etaSeconds?: number | null;
  outputBytes: number;
  currentBitrateKbps?: number | null;
  estimatedBytes: number;
  error?: string | null;
  note?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface GpuUsage {
  index: number;
  name: string;
  vendor: string;
  utilization?: number | null;
  encoder?: number | null;
  decoder?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  temperatureC?: number | null;
  source: string;
}

export interface TranscodeStats {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  gpus: GpuUsage[];
  sampledAt: number;
}

export interface CreateJobsRequest {
  files: string[];
  targetCodec: string;
  container: string;
  encoder: string;
  resolution: string;
  width?: number;
  height?: number;
  bitrateMode: string;
  bitrateKbps?: number;
  crf?: number;
  audio: string;
  concurrency: number;
  cpuThreads?: number;
  deleteOriginal: boolean;
  outputDir?: string | null;
  hdrToSdr: boolean;
}

export interface ImageFile {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  format: string;
  width: number;
  height: number;
}

export interface ImageScanResult {
  directory: string;
  scanned: number;
  matched: number;
  skippedBySize: number;
  cacheHits: number;
  files: ImageFile[];
  errors: string[];
  tookMs: number;
}

export interface ImageScanProgress {
  running: boolean;
  directory: string;
  processed: number;
  total: number;
  matched: number;
  errors: number;
  skippedBySize: number;
  cacheHits: number;
  startedAt: number;
  finishedAt?: number | null;
  tookMs: number;
  error?: string | null;
}

export interface ImageJobView {
  id: string;
  sourcePath: string;
  sourceName: string;
  outputPath: string;
  sourceFormat: string;
  width: number;
  height: number;
  sourceBytes: number;
  outputBytes: number;
  quality: number;
  lossless: boolean;
  deleteOriginal: boolean;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled' | string;
  progress: number;
  frames: number;
  error?: string | null;
  note?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface CreateImageJobsRequest {
  files: string[];
  quality: number;
  lossless: boolean;
  concurrency: number;
  cpuThreads?: number;
  deleteOriginal: boolean;
  outputDir?: string | null;
}

export type ImageEvent =
  | { type: 'imageJobUpdated'; job: ImageJobView }
  | { type: 'imageJobsCleared' };

export interface HistoryItem {
  name: string;
  status: string;
  sourceBytes: number;
  outputBytes: number;
  durationMs: number;
  outputPath: string;
  error?: string | null;
}

export interface HistoryRecord {
  id: string;
  kind: 'video' | 'image' | string;
  summary: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  total: number;
  done: number;
  failed: number;
  canceled: number;
  sourceBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent?: number | null;
  items: HistoryItem[];
}

export type TranscodeEvent =
  | { type: 'jobUpdated'; job: JobView }
  | { type: 'jobsCleared' };
