"use client";

import {
  FormEvent as ReactFormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

type Sex = "F" | "M";
type LoggerStatus = "none" | "attached" | "recovered";
type MapMode = "select" | "group" | "burrow" | "draw" | "memo";
type PrintMode = "full" | "map";
type BurrowSortKey = "label-asc" | "label-desc" | "female-ring" | "male-ring" | "updated-desc";
type IndividualFilter = "all" | "registered" | LoggerStatus;
type FilterMatchMode = "and" | "or";
type ListFilters = {
  label: string;
  female: IndividualFilter;
  male: IndividualFilter;
  notes: string;
  attachedFrom: string;
  attachedTo: string;
  recoveredFrom: string;
  recoveredTo: string;
};
type SummaryHighlightFilter = "female" | "male" | "installed" | "recovered" | "unrecovered";

type Individual = {
  registered: boolean;
  ringNumber: string;
  loggerStatus: LoggerStatus;
  attachedDate: string;
  recoveredDate: string;
};

type Burrow = {
  uid: string;
  label: string;
  x: number;
  y: number;
  individuals: Record<Sex, Individual>;
  notes: string;
  updatedAt: string;
};

type MapPoint = { x: number; y: number };
type MapStroke = { id: string; points: MapPoint[] };
type MapMemo = { id: string; x: number; y: number; text: string };
type EraseSelection = { start: MapPoint; current: MapPoint };
type GroupDrag = { start: MapPoint; ids: string[]; origins: Record<string, MapPoint> };
type AppData = { burrows: Burrow[]; strokes: MapStroke[]; memos: MapMemo[] };
type Project = { id: string; name: string; note: string; year: number; data: AppData; updatedAt: string };
type WorkspaceData = { projects: Project[] };
type YearSummary = { year: number; projects: number; burrows: number; updatedAt: string };
type StoredWorkspaceData = {
  projects: Array<Omit<Project, "note" | "year"> & { note?: string; year?: number }>;
};
type HistorySnapshot = {
  projects: Project[];
  activeYear: number | null;
  activeProjectId: string;
  selectedBurrowUid: string;
  selectedGroupUids: string[];
  selectedMemoId: string;
  selectedStrokeId: string;
  selectedSex: Sex;
  mapMode: MapMode;
};

const STORAGE_KEY = "burrow-manager-v3";
const LEGACY_APP_STORAGE_KEY = "burrow-manager-v2";
const LEGACY_RECORD_STORAGE_KEY = "burrow-manager-v1";
const ACTIVE_PROJECT_KEY = "burrow-manager-active-project-v1";
const EMPTY_APP_DATA: AppData = { burrows: [], strokes: [], memos: [] };
const CURRENT_YEAR = new Date().getFullYear();
const SYNC_POLL_INTERVAL_MS = 10_000;
const HISTORY_LIMIT = 30;

type SharedStateResponse = {
  state: WorkspaceData | null;
  revision: number;
  updatedAt: string | null;
};
type SharedSaveResponse = Pick<SharedStateResponse, "revision" | "updatedAt">;
type SharedDeleteResponse = SharedSaveResponse & { state: WorkspaceData };

const loggerLabels: Record<LoggerStatus, string> = {
  none: "未登録",
  attached: "装着済",
  recovered: "回収済",
};

const sortLabels: Record<BurrowSortKey, string> = {
  "label-asc": "巣穴ID 昇順",
  "label-desc": "巣穴ID 降順",
  "female-ring": "Fリング順",
  "male-ring": "Mリング順",
  "updated-desc": "更新が新しい順",
};

const individualFilterLabels: Record<IndividualFilter, string> = {
  all: "すべて",
  registered: "登録あり",
  none: "未登録",
  attached: "装着済",
  recovered: "回収済",
};

const filterMatchModeLabels: Record<FilterMatchMode, string> = {
  and: "AND",
  or: "OR",
};

const createEmptyListFilters = (): ListFilters => ({
  label: "",
  female: "all",
  male: "all",
  notes: "",
  attachedFrom: "",
  attachedTo: "",
  recoveredFrom: "",
  recoveredTo: "",
});

const isAppData = (value: unknown): value is AppData => {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return Array.isArray(state.burrows) && Array.isArray(state.strokes) && Array.isArray(state.memos);
};

const inferAppDataYear = (data: AppData, updatedAt?: string) => {
  const observationYears = data.burrows.flatMap((burrow) =>
    ([burrow.individuals.F, burrow.individuals.M] as Individual[]).flatMap((individual) =>
      [individual.attachedDate, individual.recoveredDate]
        .map((date) => Number(date.slice(0, 4)))
        .filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2100),
    ),
  );
  if (observationYears.length) {
    const counts = new Map<number, number>();
    observationYears.forEach((year) => counts.set(year, (counts.get(year) ?? 0) + 1));
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0][0];
  }

  if (updatedAt) {
    const updatedYear = new Date(updatedAt).getFullYear();
    if (Number.isInteger(updatedYear) && updatedYear >= 1900 && updatedYear <= 2100) return updatedYear;
  }
  return CURRENT_YEAR;
};

const normalizeProjectYear = (year: unknown, data: AppData, updatedAt: string) =>
  typeof year === "number" && Number.isInteger(year) && year >= 1900 && year <= 2100
    ? year
    : inferAppDataYear(data, updatedAt);

const isWorkspaceData = (value: unknown): value is StoredWorkspaceData => {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    Array.isArray(state.projects) &&
    state.projects.every((item) => {
      if (!item || typeof item !== "object") return false;
      const project = item as Record<string, unknown>;
      return (
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        (project.note === undefined || typeof project.note === "string") &&
        (project.year === undefined ||
          (typeof project.year === "number" &&
            Number.isInteger(project.year) &&
            project.year >= 1900 &&
            project.year <= 2100)) &&
        typeof project.updatedAt === "string" &&
        isAppData(project.data)
      );
    })
  );
};

const appDataTimestamp = (data: AppData) =>
  data.burrows.reduce(
    (latest, burrow) => (burrow.updatedAt > latest ? burrow.updatedAt : latest),
    "1970-01-01T00:00:00.000Z",
  );

const normalizeWorkspaceData = (value: unknown): WorkspaceData | null => {
  if (isWorkspaceData(value)) {
    return {
      projects: value.projects.map((project) => ({
        ...project,
        note: project.note ?? "",
        year: normalizeProjectYear(project.year, project.data, project.updatedAt),
      })),
    };
  }
  if (!isAppData(value)) return null;
  return {
    projects: [
      {
        id: "project-1",
        name: "区画 1",
        note: "",
        year: inferAppDataYear(value),
        data: value,
        updatedAt: appDataTimestamp(value),
      },
    ],
  };
};

const loadSharedState = async (): Promise<SharedStateResponse> => {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error("共有データを読み込めませんでした。");
  const payload = (await response.json()) as Omit<SharedStateResponse, "state"> & { state: unknown };
  const state = payload.state === null ? null : normalizeWorkspaceData(payload.state);
  if (payload.state !== null && !state) throw new Error("共有データの形式が正しくありません。");
  return { ...payload, state };
};

const loadSharedRevision = async (): Promise<Pick<SharedStateResponse, "revision" | "updatedAt">> => {
  const response = await fetch("/api/state?revisionOnly=1", { cache: "no-store" });
  if (!response.ok) throw new Error("共有データの更新を確認できませんでした。");
  return (await response.json()) as Pick<SharedStateResponse, "revision" | "updatedAt">;
};

const saveSharedState = async (state: WorkspaceData): Promise<SharedSaveResponse> => {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!response.ok) throw new Error("共有データを保存できませんでした。");
  return (await response.json()) as SharedSaveResponse;
};

const deleteSharedYear = async (year: number, password: string): Promise<SharedDeleteResponse> => {
  const response = await fetch("/api/state", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ year, password }),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<SharedDeleteResponse> & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "年ページを削除できませんでした。");
  const state = normalizeWorkspaceData(payload.state);
  if (!state || typeof payload.revision !== "number") {
    throw new Error("削除後の共有データを確認できませんでした。");
  }
  return {
    state,
    revision: payload.revision,
    updatedAt: payload.updatedAt ?? null,
  };
};

const persistLocalState = (state: WorkspaceData) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Cloud sync remains authoritative when local browser storage is unavailable.
  }
};

const loadActiveProjectId = () => {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
};

const persistActiveProjectId = (projectId: string) => {
  try {
    if (projectId) window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // Project selection is a device-local preference only.
  }
};

const emptyIndividual = (): Individual => ({
  registered: false,
  ringNumber: "",
  loggerStatus: "none",
  attachedDate: "",
  recoveredDate: "",
});

const createSampleData = (): AppData => ({
  burrows: [
    {
      uid: "burrow-1",
      label: "B-001",
      x: 28,
      y: 35,
      individuals: {
        F: {
          registered: true,
          ringNumber: "R-184",
          loggerStatus: "attached",
          attachedDate: "2026-07-18",
          recoveredDate: "",
        },
        M: {
          registered: true,
          ringNumber: "R-185",
          loggerStatus: "none",
          attachedDate: "",
          recoveredDate: "",
        },
      },
      notes: "草の根元。入口は東向き。",
      updatedAt: new Date().toISOString(),
    },
    {
      uid: "burrow-2",
      label: "B-002",
      x: 63,
      y: 57,
      individuals: {
        F: emptyIndividual(),
        M: {
          registered: true,
          ringNumber: "R-207",
          loggerStatus: "recovered",
          attachedDate: "2026-07-12",
          recoveredDate: "2026-07-28",
        },
      },
      notes: "石の横。周囲に踏み跡あり。",
      updatedAt: new Date().toISOString(),
    },
  ],
  strokes: [
    {
      id: "stroke-1",
      points: [
        { x: 8, y: 26 },
        { x: 18, y: 21 },
        { x: 29, y: 23 },
        { x: 39, y: 31 },
        { x: 52, y: 32 },
        { x: 67, y: 27 },
        { x: 83, y: 30 },
        { x: 93, y: 39 },
      ],
    },
    {
      id: "stroke-2",
      points: [
        { x: 12, y: 73 },
        { x: 25, y: 65 },
        { x: 41, y: 67 },
        { x: 55, y: 74 },
        { x: 72, y: 70 },
        { x: 88, y: 63 },
      ],
    },
  ],
  memos: [
    { id: "memo-1", x: 17, y: 16, text: "北斜面" },
    { id: "memo-2", x: 77, y: 75, text: "低木帯" },
  ],
});

const createEmptyData = (): AppData => ({ burrows: [], strokes: [], memos: [] });

const createProject = (name: string, data = createEmptyData(), year = CURRENT_YEAR): Project => ({
  id: `project-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  name,
  note: "",
  year,
  data,
  updatedAt: new Date().toISOString(),
});

const cloneAppData = (data: AppData): AppData => ({
  burrows: data.burrows.map((burrow) => ({
    ...burrow,
    individuals: {
      F: { ...burrow.individuals.F },
      M: { ...burrow.individuals.M },
    },
  })),
  strokes: data.strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  })),
  memos: data.memos.map((memo) => ({ ...memo })),
});

const cloneWorkspaceData = (data: WorkspaceData): WorkspaceData => ({
  projects: data.projects.map((project) => ({
    ...project,
    data: cloneAppData(project.data),
  })),
});

const createCopyName = (baseName: string, usedNames: Set<string>) => {
  const fallbackName = baseName.trim() || "名称未設定";
  const firstCopyName = `${fallbackName} コピー`;
  if (!usedNames.has(firstCopyName)) return firstCopyName;

  let number = 2;
  while (usedNames.has(`${firstCopyName} ${number}`)) number += 1;
  return `${firstCopyName} ${number}`;
};

const formatPdfFileDate = (date: Date) =>
  `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

const formatPdfTitle = (projectName: string | undefined, year: number | null, date: Date) => {
  const safeProjectName = (projectName?.trim() || "区画").replace(/[\\/:*?"<>|]/g, " ");
  return `${year ? `${year}年` : ""}${safeProjectName}${formatPdfFileDate(date)}`;
};

const setPageTitle = (title: string) => {
  document.title = title;
};

const clampMapCoordinate = (value: number) => Math.min(98, Math.max(2, value));

const getSelectionBox = (selection: EraseSelection) => {
  const left = Math.min(selection.start.x, selection.current.x);
  const top = Math.min(selection.start.y, selection.current.y);
  return {
    left,
    top,
    right: Math.max(selection.start.x, selection.current.x),
    bottom: Math.max(selection.start.y, selection.current.y),
    width: Math.abs(selection.current.x - selection.start.x),
    height: Math.abs(selection.current.y - selection.start.y),
  };
};

const isBurrowInSelection = (burrow: Burrow, selection: EraseSelection) => {
  const box = getSelectionBox(selection);
  return burrow.x >= box.left && burrow.x <= box.right && burrow.y >= box.top && burrow.y <= box.bottom;
};

const compareText = (left: string, right: string) =>
  left.localeCompare(right, "ja", { numeric: true, sensitivity: "base" });

const compareBlankLast = (left: string, right: string) => {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return compareText(left, right);
};

const individualMatchesFilter = (individual: Individual, filter: IndividualFilter) => {
  if (filter === "all") return true;
  if (filter === "registered") return individual.registered;
  if (filter === "none") return !individual.registered || individual.loggerStatus === "none";
  return individual.registered && individual.loggerStatus === filter;
};

const individualMatchesDateRange = (individual: Individual, key: "attachedDate" | "recoveredDate", from: string, to: string) => {
  if (!from && !to) return true;
  if (!individual.registered || !individual[key]) return false;
  if (from && individual[key] < from) return false;
  if (to && individual[key] > to) return false;
  return true;
};

const burrowMatchesDateRange = (burrow: Burrow, key: "attachedDate" | "recoveredDate", from: string, to: string) =>
  (["F", "M"] as Sex[]).some((sex) => individualMatchesDateRange(burrow.individuals[sex], key, from, to));

const getSearchableDateTokens = (date: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date ? [date] : [];
  const [, year, month, day] = match;
  return [
    date,
    `${year}/${month}/${day}`,
    `${month}/${day}`,
    `${Number(month)}/${Number(day)}`,
    `${month}${day}`,
  ];
};

const burrowMatchesSummaryHighlight = (burrow: Burrow, filter: SummaryHighlightFilter) => {
  if (filter === "female") {
    return burrow.individuals.F.registered && burrow.individuals.F.loggerStatus !== "none";
  }
  if (filter === "male") {
    return burrow.individuals.M.registered && burrow.individuals.M.loggerStatus !== "none";
  }
  if (filter === "installed") {
    return (["F", "M"] as Sex[]).some(
      (sex) => burrow.individuals[sex].registered && burrow.individuals[sex].loggerStatus !== "none",
    );
  }
  if (filter === "recovered") {
    return (["F", "M"] as Sex[]).some(
      (sex) => burrow.individuals[sex].registered && burrow.individuals[sex].loggerStatus === "recovered",
    );
  }
  return (["F", "M"] as Sex[]).some(
    (sex) => burrow.individuals[sex].registered && burrow.individuals[sex].loggerStatus === "attached",
  );
};

const distanceToSegment = (point: MapPoint, start: MapPoint, end: MapPoint) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const position = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + position * dx), point.y - (start.y + position * dy));
};

const findNearestStroke = (point: MapPoint, strokes: MapStroke[], threshold = 2.4) => {
  let nearest: MapStroke | undefined;
  let nearestDistance = threshold;
  strokes.forEach((stroke) => {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const distance = distanceToSegment(point, stroke.points[index - 1], stroke.points[index]);
      if (distance <= nearestDistance) {
        nearest = stroke;
        nearestDistance = distance;
      }
    }
  });
  return nearest;
};

const createInitialWorkspace = (): WorkspaceData => ({
  projects: [
    {
      id: "project-1",
      name: "区画 1",
      note: "",
      year: CURRENT_YEAR,
      data: createSampleData(),
      updatedAt: new Date().toISOString(),
    },
  ],
});

const createBurrow = (x: number, y: number, index: number): Burrow => ({
  uid: `burrow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  label: `B-${String(index).padStart(3, "0")}`,
  x,
  y,
  individuals: { F: emptyIndividual(), M: emptyIndividual() },
  notes: "",
  updatedAt: new Date().toISOString(),
});

const eraseStrokesInSelection = (strokes: MapStroke[], selection: EraseSelection) => {
  const left = Math.min(selection.start.x, selection.current.x);
  const right = Math.max(selection.start.x, selection.current.x);
  const top = Math.min(selection.start.y, selection.current.y);
  const bottom = Math.max(selection.start.y, selection.current.y);
  if (right - left < 0.4 || bottom - top < 0.4) return strokes;

  const isInside = (point: MapPoint) =>
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;

  return strokes.flatMap((stroke) => {
    const densePoints: MapPoint[] = [];
    stroke.points.forEach((point, index) => {
      if (index === 0) {
        densePoints.push(point);
        return;
      }
      const previous = stroke.points[index - 1];
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const steps = Math.max(1, Math.ceil(distance / 0.35));
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        densePoints.push({
          x: previous.x + (point.x - previous.x) * ratio,
          y: previous.y + (point.y - previous.y) * ratio,
        });
      }
    });

    if (!densePoints.some(isInside)) return [stroke];

    const runs: MapPoint[][] = [];
    let currentRun: MapPoint[] = [];
    densePoints.forEach((point) => {
      if (isInside(point)) {
        if (currentRun.length > 1) runs.push(currentRun);
        currentRun = [];
      } else {
        currentRun.push(point);
      }
    });
    if (currentRun.length > 1) runs.push(currentRun);

    return runs.map((points, index) => ({
      id: `${stroke.id}-part-${index}`,
      points,
    }));
  });
};

const migrateLegacyData = (legacy: unknown): AppData | null => {
  if (!Array.isArray(legacy)) return null;

  const burrows = legacy.map((record, index) => {
    const item = record as Record<string, unknown>;
    const sex: Sex = item.sex === "M" ? "M" : "F";
    const individual: Individual = {
      registered: Boolean(item.sex || item.ringNumber || item.hasLogger),
      ringNumber: typeof item.ringNumber === "string" ? item.ringNumber : "",
      loggerStatus: item.recoveredDate
        ? "recovered"
        : item.hasLogger
          ? "attached"
          : "none",
      attachedDate: typeof item.attachedDate === "string" ? item.attachedDate : "",
      recoveredDate: typeof item.recoveredDate === "string" ? item.recoveredDate : "",
    };

    return {
      uid: `legacy-${index}-${Date.now()}`,
      label: typeof item.id === "string" ? item.id : `B-${String(index + 1).padStart(3, "0")}`,
      x: typeof item.x === "number" ? item.x : 50,
      y: typeof item.y === "number" ? item.y : 50,
      individuals: {
        F: sex === "F" ? individual : emptyIndividual(),
        M: sex === "M" ? individual : emptyIndividual(),
      },
      notes: typeof item.notes === "string" ? item.notes : "",
      updatedAt: new Date().toISOString(),
    } satisfies Burrow;
  });

  return { burrows, strokes: [], memos: [] };
};

export default function Home() {
  return <BurrowApp />;
}

function BurrowApp() {
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const memoEditorRef = useRef<HTMLTextAreaElement>(null);
  const burrowLabelInputRef = useRef<HTMLInputElement>(null);
  const drawingIdRef = useRef<string | null>(null);
  const eraseSelectionRef = useRef<EraseSelection | null>(null);
  const groupSelectionRef = useRef<EraseSelection | null>(null);
  const groupDragRef = useRef<GroupDrag | null>(null);
  const lastCreatedBurrowRef = useRef<{ id: string; createdAt: number } | null>(null);
  const pendingBurrowLabelFocusRef = useRef("");
  const memoModeCreationRef = useRef(0);
  const dragRef = useRef<{ kind: "burrow" | "memo"; id: string } | null>(null);
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData>(createInitialWorkspace);
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [activeProjectId, setActiveProjectId] = useState("project-1");
  const [mapHistory, setMapHistory] = useState<HistorySnapshot[]>([]);
  const [mapFuture, setMapFuture] = useState<HistorySnapshot[]>([]);
  const [selectedBurrowUid, setSelectedBurrowUid] = useState("burrow-1");
  const [selectedGroupUids, setSelectedGroupUids] = useState<string[]>([]);
  const [selectedMemoId, setSelectedMemoId] = useState("");
  const [selectedStrokeId, setSelectedStrokeId] = useState("");
  const [editingMemoId, setEditingMemoId] = useState("");
  const [eraseSelection, setEraseSelection] = useState<EraseSelection | null>(null);
  const [groupSelection, setGroupSelection] = useState<EraseSelection | null>(null);
  const [selectedSex, setSelectedSex] = useState<Sex>("F");
  const [mapMode, setMapMode] = useState<MapMode>("select");
  const [searchQuery, setSearchQuery] = useState("");
  const [draggingProjectId, setDraggingProjectId] = useState("");
  const [dragOverProjectId, setDragOverProjectId] = useState("");
  const [listFilters, setListFilters] = useState<ListFilters>(createEmptyListFilters);
  const [filterMatchMode, setFilterMatchMode] = useState<FilterMatchMode>("and");
  const [burrowSortKey, setBurrowSortKey] = useState<BurrowSortKey>("label-asc");
  const [summaryHighlightFilters, setSummaryHighlightFilters] = useState<SummaryHighlightFilter[]>([]);
  const [printTimestamp, setPrintTimestamp] = useState("");
  const [printMode, setPrintMode] = useState<PrintMode>("full");
  const [printChoiceOpen, setPrintChoiceOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [burrowListOpen, setBurrowListOpen] = useState(false);
  const [saveState, setSaveState] = useState("読み込み中...");
  const [manualReadOnly, setManualReadOnly] = useState(true);
  const [editPasswordOpen, setEditPasswordOpen] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [editPasswordMessage, setEditPasswordMessage] = useState("");
  const [editPasswordSubmitting, setEditPasswordSubmitting] = useState(false);
  const [deleteYearTarget, setDeleteYearTarget] = useState<YearSummary | null>(null);
  const [deleteYearPassword, setDeleteYearPassword] = useState("");
  const [deleteYearMessage, setDeleteYearMessage] = useState("");
  const [deleteYearSubmitting, setDeleteYearSubmitting] = useState(false);
  const [endingEditing, setEndingEditing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const yearProjects = useMemo(
    () => activeYear === null ? [] : workspaceData.projects.filter((project) => project.year === activeYear),
    [activeYear, workspaceData.projects],
  );
  const yearSummaries = useMemo(
    () => {
      const summaries = new Map<number, YearSummary>();
      workspaceData.projects.forEach((project) => {
        const current = summaries.get(project.year);
        summaries.set(project.year, {
          year: project.year,
          projects: (current?.projects ?? 0) + 1,
          burrows: (current?.burrows ?? 0) + project.data.burrows.length,
          updatedAt: current && current.updatedAt > project.updatedAt ? current.updatedAt : project.updatedAt,
        });
      });
      return [...summaries.values()].sort((left, right) => right.year - left.year);
    },
    [workspaceData.projects],
  );
  const activeProject = workspaceData.projects.find(
    (project) => project.id === activeProjectId && (activeYear === null || project.year === activeYear),
  );
  const data = activeProject?.data ?? EMPTY_APP_DATA;
  const isReadOnly = manualReadOnly || endingEditing;
  const workspaceRef = useRef(workspaceData);
  const revisionRef = useRef(0);
  const lastSyncedJsonRef = useRef("");
  const dirtyRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const isReadOnlyRef = useRef(true);

  const setData = useCallback(
    (next: AppData | ((current: AppData) => AppData)) => {
      if (isReadOnlyRef.current) return;
      setWorkspaceData((current) => ({
        projects: current.projects.map((project) => {
          if (project.id !== activeProjectId) return project;
          const nextData = typeof next === "function" ? next(project.data) : next;
          if (nextData === project.data) return project;
          return { ...project, data: nextData, updatedAt: new Date().toISOString() };
        }),
      }));
    },
    [activeProjectId],
  );

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch(() => {
          // Offline support is best effort and should never block the app.
        });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      let localData = createInitialWorkspace();
      if (cancelled) return;
      isReadOnlyRef.current = true;
      setManualReadOnly(true);

      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as unknown;
          const normalized = normalizeWorkspaceData(parsed);
          if (normalized) localData = normalized;
        } else {
          const legacyAppSaved = window.localStorage.getItem(LEGACY_APP_STORAGE_KEY);
          const legacyApp = legacyAppSaved
            ? normalizeWorkspaceData(JSON.parse(legacyAppSaved))
            : null;
          if (legacyApp) {
            localData = legacyApp;
          } else {
            const legacyRecordSaved = window.localStorage.getItem(LEGACY_RECORD_STORAGE_KEY);
            const migrated = legacyRecordSaved
              ? migrateLegacyData(JSON.parse(legacyRecordSaved))
              : null;
            const migratedWorkspace = migrated ? normalizeWorkspaceData(migrated) : null;
            if (migratedWorkspace) localData = migratedWorkspace;
          }
        }
      } catch {
        // Continue with sample data and let the shared database become authoritative.
      }

      if (cancelled) return;
      const storedProjectId = loadActiveProjectId();
      const localProjectId = localData.projects.some((project) => project.id === storedProjectId)
        ? storedProjectId!
        : localData.projects[0]?.id ?? "";
      const localProject = localData.projects.find((project) => project.id === localProjectId);
      workspaceRef.current = localData;
      setWorkspaceData(localData);
      setActiveProjectId(localProjectId);
      setSelectedBurrowUid(localProject?.data.burrows[0]?.uid ?? "");
      setSaveState("読み取り専用");

      try {
        const shared = await loadSharedState();
        if (cancelled) return;
        const nextData = shared.state ?? localData;
        const nextRevision = shared.revision;

        if (cancelled) return;
        persistLocalState(nextData);
        const serialized = JSON.stringify(nextData);
        const nextProjectId = nextData.projects.some((project) => project.id === storedProjectId)
          ? storedProjectId!
          : nextData.projects[0]?.id ?? "";
        const nextProject = nextData.projects.find((project) => project.id === nextProjectId);
        workspaceRef.current = nextData;
        revisionRef.current = nextRevision;
        lastSyncedJsonRef.current = serialized;
        dirtyRef.current = false;
        setWorkspaceData(nextData);
        setActiveProjectId(nextProjectId);
        setSelectedBurrowUid(nextProject?.data.burrows[0]?.uid ?? "");
        setSaveState("読み取り専用");
      } catch {
        lastSyncedJsonRef.current = "";
        dirtyRef.current = false;
        setSaveState("読み取り専用（オフライン）");
      } finally {
        if (!cancelled) setHydrated(true);
      }
    };

    void initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    workspaceRef.current = workspaceData;
    persistLocalState(workspaceData);
    if (isReadOnly) {
      dirtyRef.current = false;
      return;
    }
    const serialized = JSON.stringify(workspaceData);
    if (serialized === lastSyncedJsonRef.current) {
      dirtyRef.current = false;
      return;
    }

    dirtyRef.current = true;
    setSaveState("同期中...");
    const timer = window.setTimeout(async () => {
      if (syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      const stateToSave = workspaceRef.current;
      const savingJson = JSON.stringify(stateToSave);
      try {
        const saved = await saveSharedState(stateToSave);
        revisionRef.current = saved.revision;
        if (JSON.stringify(workspaceRef.current) === savingJson) {
          lastSyncedJsonRef.current = savingJson;
          dirtyRef.current = false;
          setSaveState("同期済み");
        }
      } catch {
        dirtyRef.current = true;
        setSaveState("オフライン保存中");
      } finally {
        syncInFlightRef.current = false;
      }
    }, 900);

    return () => window.clearTimeout(timer);
  }, [workspaceData, hydrated, isReadOnly]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;

    const syncNow = async () => {
      if (cancelled || document.visibilityState === "hidden" || syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      try {
        if (dirtyRef.current && !isReadOnly) {
          const stateToSave = workspaceRef.current;
          const savingJson = JSON.stringify(stateToSave);
          const saved = await saveSharedState(stateToSave);
          revisionRef.current = saved.revision;
          if (JSON.stringify(workspaceRef.current) === savingJson) {
            lastSyncedJsonRef.current = savingJson;
            dirtyRef.current = false;
            setSaveState("同期済み");
          }
          return;
        }

        const revision = await loadSharedRevision();
        if (revision.revision <= revisionRef.current || cancelled) return;
        const shared = await loadSharedState();
        if (!shared.state || shared.revision <= revisionRef.current || cancelled) return;
        const remoteState = shared.state;
        const serialized = JSON.stringify(remoteState);
        const remoteYearProjects = activeYear === null
          ? remoteState.projects
          : remoteState.projects.filter((project) => project.year === activeYear);
        const nextProjectId = remoteYearProjects.some((project) => project.id === activeProjectId)
          ? activeProjectId
          : remoteYearProjects[0]?.id ?? remoteState.projects[0]?.id ?? "";
        const nextProject = remoteState.projects.find((project) => project.id === nextProjectId);
        revisionRef.current = shared.revision;
        lastSyncedJsonRef.current = serialized;
        dirtyRef.current = false;
        workspaceRef.current = remoteState;
        persistLocalState(remoteState);
        setWorkspaceData(remoteState);
        if (activeYear !== null && !remoteYearProjects.length) setActiveYear(null);
        setActiveProjectId(nextProjectId);
        setSelectedBurrowUid((current) =>
          nextProject?.data.burrows.some((burrow) => burrow.uid === current)
            ? current
            : nextProject?.data.burrows[0]?.uid ?? "",
        );
        setSelectedMemoId((current) =>
          nextProject?.data.memos.some((memo) => memo.id === current) ? current : "",
        );
        setSelectedStrokeId((current) =>
          nextProject?.data.strokes.some((stroke) => stroke.id === current) ? current : "",
        );
        setSaveState(isReadOnly ? "読み取り専用" : "同期済み");
      } catch {
        setSaveState(isReadOnly ? "読み取り専用（オフライン）" : "オフライン保存中");
      } finally {
        syncInFlightRef.current = false;
      }
    };

    const interval = window.setInterval(() => void syncNow(), SYNC_POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    window.addEventListener("focus", syncNow);
    window.addEventListener("online", syncNow);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", syncNow);
      window.removeEventListener("online", syncNow);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeProjectId, activeYear, hydrated, isReadOnly]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) return;

    const render = () => {
      const bounds = map.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, bounds.width, bounds.height);
      context.lineCap = "round";
      context.lineJoin = "round";

      const drawStroke = (stroke: MapStroke, selected: boolean) => {
        if (stroke.points.length < 2) return;
        context.strokeStyle = selected ? "rgba(161, 61, 54, 0.96)" : "rgba(53, 55, 49, 0.72)";
        context.lineWidth = selected ? 4.5 : 2.5;
        context.beginPath();
        stroke.points.forEach((point, index) => {
          const x = (point.x / 100) * bounds.width;
          const y = (point.y / 100) * bounds.height;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      };

      data.strokes.filter((stroke) => stroke.id !== selectedStrokeId).forEach((stroke) => drawStroke(stroke, false));
      const selected = data.strokes.find((stroke) => stroke.id === selectedStrokeId);
      if (selected) drawStroke(selected, true);
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(map);
    return () => observer.disconnect();
  }, [data.strokes, selectedStrokeId]);

  const selectedBurrow = useMemo(
    () => data.burrows.find((burrow) => burrow.uid === selectedBurrowUid),
    [data, selectedBurrowUid],
  );

  const selectedMemo = useMemo(
    () => data.memos.find((memo) => memo.id === selectedMemoId),
    [data, selectedMemoId],
  );

  const selectedStroke = useMemo(
    () => data.strokes.find((stroke) => stroke.id === selectedStrokeId),
    [data.strokes, selectedStrokeId],
  );

  useEffect(() => {
    if (!editingMemoId) return;
    memoEditorRef.current?.focus();
  }, [editingMemoId]);

  useEffect(() => {
    if (!pendingBurrowLabelFocusRef.current || pendingBurrowLabelFocusRef.current !== selectedBurrowUid) return;
    const input = burrowLabelInputRef.current;
    if (!input) return;
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
      pendingBurrowLabelFocusRef.current = "";
    });
  }, [selectedBurrowUid, selectedBurrow]);

  const selectedIndividual = selectedBurrow?.individuals[selectedSex];

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase("ja");
  const normalizedListLabel = listFilters.label.trim().toLocaleLowerCase("ja");
  const normalizedListNotes = listFilters.notes.trim().toLocaleLowerCase("ja");
  const filteredBurrows = useMemo(() => {
    return data.burrows.filter((burrow) => {
      const activeConditions: boolean[] = [];
      if (normalizedListLabel) {
        activeConditions.push(burrow.label.toLocaleLowerCase("ja").includes(normalizedListLabel));
      }
      if (listFilters.female !== "all") {
        activeConditions.push(individualMatchesFilter(burrow.individuals.F, listFilters.female));
      }
      if (listFilters.male !== "all") {
        activeConditions.push(individualMatchesFilter(burrow.individuals.M, listFilters.male));
      }
      if (listFilters.attachedFrom || listFilters.attachedTo) {
        activeConditions.push(
          burrowMatchesDateRange(burrow, "attachedDate", listFilters.attachedFrom, listFilters.attachedTo),
        );
      }
      if (listFilters.recoveredFrom || listFilters.recoveredTo) {
        activeConditions.push(
          burrowMatchesDateRange(burrow, "recoveredDate", listFilters.recoveredFrom, listFilters.recoveredTo),
        );
      }
      if (normalizedListNotes) {
        activeConditions.push(burrow.notes.toLocaleLowerCase("ja").includes(normalizedListNotes));
      }
      const searchable = [burrow.label, burrow.notes];
      (["F", "M"] as Sex[]).forEach((sex) => {
        const individual = burrow.individuals[sex];
        if (!individual.registered) return;
        searchable.push(
          sex,
          individual.ringNumber,
          loggerLabels[individual.loggerStatus],
          ...getSearchableDateTokens(individual.attachedDate),
          ...getSearchableDateTokens(individual.recoveredDate),
        );
      });
      if (normalizedSearch) {
        activeConditions.push(searchable.join(" ").toLocaleLowerCase("ja").includes(normalizedSearch));
      }
      if (!activeConditions.length) return true;
      return filterMatchMode === "and"
        ? activeConditions.every(Boolean)
        : activeConditions.some(Boolean);
    });
  }, [
    data,
    filterMatchMode,
    listFilters.attachedFrom,
    listFilters.attachedTo,
    listFilters.female,
    listFilters.male,
    listFilters.recoveredFrom,
    listFilters.recoveredTo,
    normalizedListLabel,
    normalizedListNotes,
    normalizedSearch,
  ]);

  const hasListFilters = Boolean(
    normalizedListLabel ||
      normalizedListNotes ||
      listFilters.female !== "all" ||
      listFilters.male !== "all" ||
      listFilters.attachedFrom ||
      listFilters.attachedTo ||
      listFilters.recoveredFrom ||
      listFilters.recoveredTo,
  );

  const matchingBurrowUids = useMemo(
    () => new Set(filteredBurrows.map((burrow) => burrow.uid)),
    [filteredBurrows],
  );

  const summaryHighlightBurrowUids = useMemo(() => {
    if (!summaryHighlightFilters.length) return new Set<string>();
    return new Set(
      data.burrows
        .filter((burrow) =>
          filterMatchMode === "and"
            ? summaryHighlightFilters.every((filter) => burrowMatchesSummaryHighlight(burrow, filter))
            : summaryHighlightFilters.some((filter) => burrowMatchesSummaryHighlight(burrow, filter)),
        )
        .map((burrow) => burrow.uid),
    );
  }, [data, filterMatchMode, summaryHighlightFilters]);

  const listOrSearchHighlightActive = Boolean(normalizedSearch || hasListFilters);
  const mapHighlightActive = Boolean(listOrSearchHighlightActive || summaryHighlightFilters.length);
  const isBurrowHighlightedOnMap = (burrowUid: string) => {
    const matchesListOrSearch = !listOrSearchHighlightActive || matchingBurrowUids.has(burrowUid);
    const matchesSummary = !summaryHighlightFilters.length || summaryHighlightBurrowUids.has(burrowUid);
    if (filterMatchMode === "or") {
      return (
        (listOrSearchHighlightActive && matchesListOrSearch) ||
        (Boolean(summaryHighlightFilters.length) && matchesSummary)
      );
    }
    return matchesListOrSearch && matchesSummary;
  };

  const sortedFilteredBurrows = useMemo(() => {
    const burrows = [...filteredBurrows];
    burrows.sort((left, right) => {
      if (burrowSortKey === "label-desc") return compareText(right.label, left.label);
      if (burrowSortKey === "female-ring") {
        return (
          compareBlankLast(left.individuals.F.ringNumber.trim(), right.individuals.F.ringNumber.trim()) ||
          compareText(left.label, right.label)
        );
      }
      if (burrowSortKey === "male-ring") {
        return (
          compareBlankLast(left.individuals.M.ringNumber.trim(), right.individuals.M.ringNumber.trim()) ||
          compareText(left.label, right.label)
        );
      }
      if (burrowSortKey === "updated-desc") {
        return right.updatedAt.localeCompare(left.updatedAt) || compareText(left.label, right.label);
      }
      return compareText(left.label, right.label);
    });
    return burrows;
  }, [burrowSortKey, filteredBurrows]);

  const selectedGroupUidSet = useMemo(() => new Set(selectedGroupUids), [selectedGroupUids]);

  const selectedGroupBox = useMemo(() => {
    const burrows = data.burrows.filter((burrow) => selectedGroupUidSet.has(burrow.uid));
    if (!burrows.length) return null;
    const minX = Math.min(...burrows.map((burrow) => burrow.x));
    const maxX = Math.max(...burrows.map((burrow) => burrow.x));
    const minY = Math.min(...burrows.map((burrow) => burrow.y));
    const maxY = Math.max(...burrows.map((burrow) => burrow.y));
    const left = clampMapCoordinate(minX - 3);
    const top = clampMapCoordinate(minY - 3);
    const right = clampMapCoordinate(maxX + 3);
    const bottom = clampMapCoordinate(maxY + 3);
    return { left, top, width: Math.max(4, right - left), height: Math.max(4, bottom - top) };
  }, [data, selectedGroupUidSet]);

  const summary = useMemo(() => {
    const individuals = data.burrows.flatMap((burrow) =>
      (["F", "M"] as Sex[])
        .map((sex) => ({ sex, ...burrow.individuals[sex] }))
        .filter((individual) => individual.registered && individual.loggerStatus !== "none"),
    );

    const installed = individuals.filter((individual) => individual.loggerStatus !== "none").length;
    const recovered = individuals.filter((individual) => individual.loggerStatus === "recovered").length;

    return {
      burrows: data.burrows.length,
      total: individuals.length,
      female: individuals.filter((individual) => individual.sex === "F").length,
      male: individuals.filter((individual) => individual.sex === "M").length,
      installed,
      recovered,
      unrecovered: installed - recovered,
    };
  }, [data]);

  const printTargets = useMemo(() => {
    const targets = data.burrows.flatMap((burrow) =>
      (["F", "M"] as Sex[]).flatMap((sex) => {
        const individual = burrow.individuals[sex];
        if (!individual.registered) return [];
        return [{ burrowLabel: burrow.label, sex, individual }];
      }),
    );
    const sortTargets = (left: (typeof targets)[number], right: (typeof targets)[number]) =>
      compareText(left.burrowLabel, right.burrowLabel) || compareText(left.sex, right.sex);
    return {
      attachment: targets.filter(({ individual }) => individual.loggerStatus === "none").sort(sortTargets),
      recovery: targets.filter(({ individual }) => individual.loggerStatus === "attached").sort(sortTargets),
    };
  }, [data]);

  const duplicateRing = Boolean(
    selectedIndividual?.registered &&
      selectedIndividual.ringNumber.trim() &&
      data.burrows.some((burrow) =>
        (["F", "M"] as Sex[]).some(
          (sex) =>
            !(burrow.uid === selectedBurrow?.uid && sex === selectedSex) &&
            burrow.individuals[sex].registered &&
            burrow.individuals[sex].ringNumber.trim() === selectedIndividual.ringNumber.trim(),
        ),
      ),
  );

  const duplicateBurrowLabel = Boolean(
    selectedBurrow?.label.trim() &&
      data.burrows.some(
        (burrow) =>
          burrow.uid !== selectedBurrow.uid &&
          burrow.label.trim().toLocaleLowerCase("ja") === selectedBurrow.label.trim().toLocaleLowerCase("ja"),
      ),
  );

  const invalidRecovery = Boolean(
    selectedIndividual?.attachedDate &&
      selectedIndividual.recoveredDate &&
      selectedIndividual.recoveredDate < selectedIndividual.attachedDate,
  );

  const pointFromEvent = (event: { clientX: number; clientY: number }): MapPoint | null => {
    const map = mapRef.current;
    if (!map) return null;
    const bounds = map.getBoundingClientRect();
    return {
      x: clampMapCoordinate(((event.clientX - bounds.left) / bounds.width) * 100),
      y: clampMapCoordinate(((event.clientY - bounds.top) / bounds.height) * 100),
    };
  };

  const createHistorySnapshot = (): HistorySnapshot => ({
    projects: cloneWorkspaceData({ projects: activeYear === null ? workspaceData.projects : yearProjects }).projects,
    activeYear,
    activeProjectId,
    selectedBurrowUid,
    selectedGroupUids: [...selectedGroupUids],
    selectedMemoId,
    selectedStrokeId,
    selectedSex,
    mapMode,
  });

  const restoreHistorySnapshot = (snapshot: HistorySnapshot) => {
    const snapshotYearProjects = snapshot.projects;
    const nextProjectId = snapshotYearProjects.some((project) => project.id === snapshot.activeProjectId)
      ? snapshot.activeProjectId
      : snapshotYearProjects[0]?.id ?? workspaceData.projects[0]?.id ?? "project-1";
    const restoredProjects = snapshot.activeYear === null
      ? snapshotYearProjects
      : [
          ...workspaceData.projects.filter((project) => project.year !== snapshot.activeYear),
          ...snapshotYearProjects,
        ];
    const nextProject = restoredProjects.find((project) => project.id === nextProjectId);
    setWorkspaceData(cloneWorkspaceData({ projects: restoredProjects }));
    setActiveYear(snapshot.activeYear);
    setActiveProjectId(nextProjectId);
    persistActiveProjectId(nextProjectId);
    setSelectedBurrowUid(
      nextProject?.data.burrows.some((burrow) => burrow.uid === snapshot.selectedBurrowUid)
        ? snapshot.selectedBurrowUid
        : nextProject?.data.burrows[0]?.uid ?? "",
    );
    setSelectedGroupUids(
      snapshot.selectedGroupUids.filter((uid) => nextProject?.data.burrows.some((burrow) => burrow.uid === uid)),
    );
    setSelectedMemoId(
      nextProject?.data.memos.some((memo) => memo.id === snapshot.selectedMemoId) ? snapshot.selectedMemoId : "",
    );
    setSelectedStrokeId(
      nextProject?.data.strokes.some((stroke) => stroke.id === snapshot.selectedStrokeId)
        ? snapshot.selectedStrokeId
        : "",
    );
    setSelectedSex(snapshot.selectedSex);
    setMapMode(snapshot.mapMode);
    setEditingMemoId("");
    setEraseSelection(null);
    setGroupSelection(null);
    eraseSelectionRef.current = null;
    groupSelectionRef.current = null;
    groupDragRef.current = null;
    drawingIdRef.current = null;
    dragRef.current = null;
  };

  const pushHistory = () => {
    if (isReadOnly) return;
    const snapshot = createHistorySnapshot();
    setMapHistory((current) => [...current.slice(-(HISTORY_LIMIT - 1)), snapshot]);
    setMapFuture([]);
  };

  const enterReadOnlyMode = () => {
    isReadOnlyRef.current = true;
    setManualReadOnly(true);
    setMapMode("select");
    setEditingMemoId("");
    setEraseSelection(null);
    setGroupSelection(null);
    setSelectedGroupUids([]);
    setSelectedStrokeId("");
    eraseSelectionRef.current = null;
    groupSelectionRef.current = null;
    groupDragRef.current = null;
    drawingIdRef.current = null;
    dragRef.current = null;
    setSaveState(navigator.onLine ? "読み取り専用" : "読み取り専用（オフライン）");
  };

  const requestEditing = () => {
    setEditPassword("");
    setEditPasswordMessage("");
    setEditPasswordOpen(true);
  };

  const cancelEditingRequest = () => {
    if (editPasswordSubmitting) return;
    setEditPasswordOpen(false);
    setEditPassword("");
    setEditPasswordMessage("");
  };

  const requestYearDeletion = (summary: YearSummary) => {
    if (isReadOnly || deleteYearSubmitting) return;
    setDeleteYearTarget(summary);
    setDeleteYearPassword("");
    setDeleteYearMessage("");
  };

  const cancelYearDeletion = () => {
    if (deleteYearSubmitting) return;
    setDeleteYearTarget(null);
    setDeleteYearPassword("");
    setDeleteYearMessage("");
  };

  const confirmYearDeletion = async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deleteYearTarget || !deleteYearPassword || deleteYearSubmitting || isReadOnly) return;
    setDeleteYearSubmitting(true);
    setDeleteYearMessage("");
    try {
      const deleted = await deleteSharedYear(deleteYearTarget.year, deleteYearPassword);
      const serialized = JSON.stringify(deleted.state);
      workspaceRef.current = deleted.state;
      revisionRef.current = deleted.revision;
      lastSyncedJsonRef.current = serialized;
      dirtyRef.current = false;
      persistLocalState(deleted.state);
      setWorkspaceData(deleted.state);
      setActiveYear(null);
      setActiveProjectId("");
      persistActiveProjectId("");
      setSelectedBurrowUid("");
      setSelectedMemoId("");
      setSelectedGroupUids([]);
      setMapHistory([]);
      setMapFuture([]);
      setDeleteYearTarget(null);
      setDeleteYearPassword("");
      setSaveState("同期済み");
    } catch (error) {
      setDeleteYearMessage(error instanceof Error ? error.message : "年ページを削除できませんでした。");
    } finally {
      setDeleteYearSubmitting(false);
    }
  };

  const unlockEditing = async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editPassword || editPasswordSubmitting) return;
    setEditPasswordSubmitting(true);
    setEditPasswordMessage("");
    try {
      const response = await fetch("/api/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: editPassword }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "パスワードが違います。");
      isReadOnlyRef.current = false;
      setManualReadOnly(false);
      setEditPasswordOpen(false);
      setEditPassword("");
      setSaveState(navigator.onLine ? "編集できます" : "編集できます（オフライン）");
    } catch (error) {
      setEditPasswordMessage(error instanceof Error ? error.message : "編集モードを開始できませんでした。");
    } finally {
      setEditPasswordSubmitting(false);
    }
  };

  const finishEditing = async () => {
    if (endingEditing) return;
    const stateAtFinish = workspaceData;
    const serialized = JSON.stringify(stateAtFinish);
    setEndingEditing(true);
    try {
      for (let attempt = 0; attempt < 40 && syncInFlightRef.current; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      if (dirtyRef.current || serialized !== lastSyncedJsonRef.current) {
        const saved = await saveSharedState(stateAtFinish);
        revisionRef.current = saved.revision;
        lastSyncedJsonRef.current = serialized;
        dirtyRef.current = false;
      }
      await fetch("/api/password", { method: "DELETE" });
      enterReadOnlyMode();
    } catch {
      setSaveState("保存に失敗しました。編集モードを終了していません");
    } finally {
      setEndingEditing(false);
    }
  };

  const changeMapMode = (nextMode: MapMode) => {
    if (isReadOnly && nextMode !== "select") return;
    setMapMode(nextMode);
    if (nextMode !== "select") setSelectedStrokeId("");
    if (nextMode === "group") return;
    groupSelectionRef.current = null;
    groupDragRef.current = null;
    setGroupSelection(null);
    setSelectedGroupUids([]);
  };

  const updateBurrow = (patch: Partial<Omit<Burrow, "uid" | "individuals">>) => {
    if (!selectedBurrow || isReadOnly) return;
    setData((current) => ({
      ...current,
      burrows: current.burrows.map((burrow) =>
        burrow.uid === selectedBurrow.uid
          ? { ...burrow, ...patch, updatedAt: new Date().toISOString() }
          : burrow,
      ),
    }));
  };

  const updateBurrowLabel = (label: string) => {
    if (!selectedBurrow || isReadOnly) return;
    updateBurrow({ label });
  };

  const updateIndividual = (patch: Partial<Individual>, recordHistory = true) => {
    if (!selectedBurrow || isReadOnly) return;
    if (recordHistory) pushHistory();
    setData((current) => ({
      ...current,
      burrows: current.burrows.map((burrow) =>
        burrow.uid === selectedBurrow.uid
          ? {
              ...burrow,
              individuals: {
                ...burrow.individuals,
                [selectedSex]: { ...burrow.individuals[selectedSex], ...patch },
              },
              updatedAt: new Date().toISOString(),
            }
          : burrow,
      ),
    }));
  };

  const updateMemo = (text: string) => {
    if (!selectedMemo || isReadOnly) return;
    setData((current) => ({
      ...current,
      memos: current.memos.map((memo) => (memo.id === selectedMemo.id ? { ...memo, text } : memo)),
    }));
  };

  const finishMemoEditing = (memoId: string) => {
    setEditingMemoId("");
    if (isReadOnly) return;
    setData((current) => {
      const isEmpty = !current.memos.find((memo) => memo.id === memoId)?.text.trim();
      if (isEmpty) {
        setSelectedMemoId("");
        setSelectedBurrowUid(current.burrows[0]?.uid ?? "");
      }
      return {
        ...current,
        memos: current.memos.filter((memo) => memo.id !== memoId || memo.text.trim()),
      };
    });
  };

  const startGroupDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isReadOnly) return;
    const point = pointFromEvent(event);
    if (!point || !selectedGroupUids.length || mapMode !== "group") return;
    event.preventDefault();
    event.stopPropagation();
    pushHistory();
    mapRef.current?.setPointerCapture(event.pointerId);
    const selectedBurrows = data.burrows.filter((burrow) => selectedGroupUidSet.has(burrow.uid));
    groupDragRef.current = {
      start: point,
      ids: selectedBurrows.map((burrow) => burrow.uid),
      origins: Object.fromEntries(selectedBurrows.map((burrow) => [burrow.uid, { x: burrow.x, y: burrow.y }])),
    };
  };

  const handleMapDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isReadOnly) return;
    if (Date.now() - memoModeCreationRef.current < 700) return;
    if ((event.target as HTMLElement).closest("[data-map-control]")) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    const memo: MapMemo = {
      id: `memo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      x: point.x,
      y: point.y,
      text: "",
    };
    const recentBurrow = lastCreatedBurrowRef.current;
    const accidentalBurrowId =
      mapMode === "burrow" && recentBurrow && Date.now() - recentBurrow.createdAt < 700
        ? recentBurrow.id
        : "";
    pushHistory();
    setData((current) => {
      const lastStroke = current.strokes.at(-1);
      const strokes =
        mapMode === "draw" && lastStroke?.points.length === 1
          ? current.strokes.slice(0, -1)
          : current.strokes;
      return {
        ...current,
        burrows: accidentalBurrowId
          ? current.burrows.filter((burrow) => burrow.uid !== accidentalBurrowId)
          : current.burrows,
        strokes,
        memos: [...current.memos, memo],
      };
    });
    lastCreatedBurrowRef.current = null;
    setSelectedMemoId(memo.id);
    setSelectedBurrowUid("");
    setEditingMemoId(memo.id);
    setMapMode("select");
  };

  const handleMapPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-map-control]")) return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (isReadOnly) {
      setSelectedMemoId("");
      setSelectedGroupUids([]);
      setSelectedStrokeId("");
      return;
    }

    if (mapMode === "select" && event.button === 0) {
      const stroke = findNearestStroke(point, data.strokes);
      if (stroke) {
        event.preventDefault();
        setSelectedStrokeId(stroke.id);
        setSelectedBurrowUid("");
        setSelectedMemoId("");
        setSelectedGroupUids([]);
        return;
      }
      setSelectedStrokeId("");
    }

    if (mapMode === "group" && event.button === 0) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const selection = { start: point, current: point };
      groupSelectionRef.current = selection;
      setGroupSelection(selection);
      setSelectedGroupUids([]);
      setSelectedBurrowUid("");
      setSelectedMemoId("");
      setSelectedStrokeId("");
      return;
    }

    if (event.button === 2) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const selection = { start: point, current: point };
      eraseSelectionRef.current = selection;
      setEraseSelection(selection);
      pushHistory();
      return;
    }

    if (event.button === 0 && event.detail > 1) return;

    if (mapMode === "memo") {
      event.preventDefault();
      const memo: MapMemo = {
        id: `memo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        x: point.x,
        y: point.y,
        text: "",
      };
      pushHistory();
      setData((current) => ({ ...current, memos: [...current.memos, memo] }));
      setSelectedMemoId(memo.id);
      setSelectedBurrowUid("");
      setSelectedStrokeId("");
      setEditingMemoId(memo.id);
      setMapMode("select");
      memoModeCreationRef.current = Date.now();
      return;
    }

    if (mapMode === "burrow") {
      const nextNumber =
        data.burrows.reduce((highest, burrow) => {
          const number = Number(burrow.label.match(/(\d+)$/)?.[1] ?? 0);
          return Math.max(highest, number);
        }, 0) + 1;
      const next = createBurrow(point.x, point.y, nextNumber);
      pushHistory();
      setData((current) => ({ ...current, burrows: [...current.burrows, next] }));
      lastCreatedBurrowRef.current = { id: next.uid, createdAt: Date.now() };
      pendingBurrowLabelFocusRef.current = next.uid;
      setSelectedBurrowUid(next.uid);
      setSelectedMemoId("");
      setSelectedStrokeId("");
      setSelectedSex("F");
      return;
    }

    if (mapMode === "draw") {
      event.currentTarget.setPointerCapture(event.pointerId);
      const id = `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      drawingIdRef.current = id;
      pushHistory();
      setData((current) => ({
        ...current,
        strokes: [...current.strokes, { id, points: [point] }],
      }));
      return;
    }

    setSelectedMemoId("");
    setSelectedGroupUids([]);
    setSelectedStrokeId("");
  };

  const handleMapPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isReadOnly) return;
    const point = pointFromEvent(event);
    if (!point) return;

    if (groupDragRef.current) {
      const drag = groupDragRef.current;
      const origins = Object.values(drag.origins);
      const minX = Math.min(...origins.map((origin) => origin.x));
      const maxX = Math.max(...origins.map((origin) => origin.x));
      const minY = Math.min(...origins.map((origin) => origin.y));
      const maxY = Math.max(...origins.map((origin) => origin.y));
      const dx = Math.max(2 - minX, Math.min(98 - maxX, point.x - drag.start.x));
      const dy = Math.max(2 - minY, Math.min(98 - maxY, point.y - drag.start.y));
      setData((current) => ({
        ...current,
        burrows: current.burrows.map((burrow) => {
          const origin = drag.origins[burrow.uid];
          if (!origin) return burrow;
          return { ...burrow, x: origin.x + dx, y: origin.y + dy, updatedAt: new Date().toISOString() };
        }),
      }));
      return;
    }

    if (groupSelectionRef.current) {
      const selection = { ...groupSelectionRef.current, current: point };
      groupSelectionRef.current = selection;
      setGroupSelection(selection);
      return;
    }

    if (eraseSelectionRef.current) {
      const selection = { ...eraseSelectionRef.current, current: point };
      eraseSelectionRef.current = selection;
      setEraseSelection(selection);
      return;
    }

    if (drawingIdRef.current) {
      const drawingId = drawingIdRef.current;
      setData((current) => ({
        ...current,
        strokes: current.strokes.map((stroke) => {
          if (stroke.id !== drawingId) return stroke;
          const last = stroke.points.at(-1);
          if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.35) return stroke;
          return { ...stroke, points: [...stroke.points, point] };
        }),
      }));
      return;
    }

    if (dragRef.current && mapMode === "select") {
      const drag = dragRef.current;
      setData((current) =>
        drag.kind === "burrow"
          ? {
              ...current,
              burrows: current.burrows.map((burrow) =>
                burrow.uid === drag.id ? { ...burrow, ...point } : burrow,
              ),
            }
          : {
              ...current,
              memos: current.memos.map((memo) => (memo.id === drag.id ? { ...memo, ...point } : memo)),
            },
      );
    }
  };

  const finishPointerAction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isReadOnly) {
      groupSelectionRef.current = null;
      setGroupSelection(null);
      groupDragRef.current = null;
      eraseSelectionRef.current = null;
      setEraseSelection(null);
      drawingIdRef.current = null;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const groupSelectionValue = groupSelectionRef.current;
    if (groupSelectionValue && event.type === "pointerup") {
      const ids = data.burrows
        .filter((burrow) => isBurrowInSelection(burrow, groupSelectionValue))
        .map((burrow) => burrow.uid);
      setSelectedGroupUids(ids);
      setSelectedBurrowUid(ids[0] ?? "");
      setSelectedMemoId("");
      setSelectedStrokeId("");
    }
    groupSelectionRef.current = null;
    setGroupSelection(null);
    groupDragRef.current = null;

    const selection = eraseSelectionRef.current;
    if (selection && event.type === "pointerup") {
      setData((current) => ({
        ...current,
        strokes: eraseStrokesInSelection(current.strokes, selection),
      }));
    }
    eraseSelectionRef.current = null;
    setEraseSelection(null);
    drawingIdRef.current = null;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const selectBurrow = (event: ReactPointerEvent<HTMLButtonElement>, burrow: Burrow) => {
    event.stopPropagation();
    setSelectedBurrowUid(burrow.uid);
    setSelectedMemoId("");
    setSelectedStrokeId("");
    if (!isReadOnly && mapMode === "select") {
      setSelectedGroupUids([]);
      pushHistory();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: "burrow", id: burrow.uid };
    }
  };

  const selectMemo = (event: ReactPointerEvent<HTMLButtonElement>, memo: MapMemo) => {
    event.stopPropagation();
    setSelectedMemoId(memo.id);
    setSelectedBurrowUid("");
    setSelectedGroupUids([]);
    setSelectedStrokeId("");
    if (!isReadOnly && mapMode === "select") {
      pushHistory();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: "memo", id: memo.id };
    }
  };

  const selectStroke = (event: ReactPointerEvent<SVGPolylineElement>, stroke: MapStroke) => {
    event.stopPropagation();
    if (isReadOnly || mapMode !== "select") return;
    setSelectedStrokeId(stroke.id);
    setSelectedBurrowUid("");
    setSelectedMemoId("");
    setSelectedGroupUids([]);
  };

  const deleteSelectedBurrow = () => {
    if (!selectedBurrow || isReadOnly) return;
    pushHistory();
    setData((current) => {
      const burrows = current.burrows.filter((burrow) => burrow.uid !== selectedBurrow.uid);
      setSelectedBurrowUid(burrows[0]?.uid ?? "");
      return { ...current, burrows };
    });
  };

  const deleteSelectedMemo = () => {
    if (!selectedMemo || isReadOnly) return;
    pushHistory();
    setData((current) => ({
      ...current,
      memos: current.memos.filter((memo) => memo.id !== selectedMemo.id),
    }));
    setEditingMemoId("");
    setSelectedMemoId("");
    setSelectedBurrowUid(data.burrows[0]?.uid ?? "");
  };

  const deleteSelectedStroke = () => {
    if (!selectedStroke || isReadOnly) return;
    pushHistory();
    setData((current) => ({
      ...current,
      strokes: current.strokes.filter((stroke) => stroke.id !== selectedStroke.id),
    }));
    setSelectedStrokeId("");
  };

  const undoStroke = () => {
    if (isReadOnly) return;
    const previous = mapHistory.at(-1);
    if (!previous) return;
    setMapFuture((current) => [...current.slice(-(HISTORY_LIMIT - 1)), createHistorySnapshot()]);
    setMapHistory((current) => current.slice(0, -1));
    restoreHistorySnapshot(previous);
  };

  const redoStroke = () => {
    if (isReadOnly) return;
    const next = mapFuture.at(-1);
    if (!next) return;
    setMapHistory((current) => [...current.slice(-(HISTORY_LIMIT - 1)), createHistorySnapshot()]);
    setMapFuture((current) => current.slice(0, -1));
    restoreHistorySnapshot(next);
  };

  const summaryHighlightIsActive = (filter: SummaryHighlightFilter) =>
    summaryHighlightFilters.includes(filter);

  const toggleSummaryHighlight = (filter: SummaryHighlightFilter) => {
    setSummaryHighlightFilters((current) =>
      current.includes(filter) ? current.filter((item) => item !== filter) : [...current, filter],
    );
  };

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const isTyping = Boolean(target?.closest("input, textarea, [contenteditable='true']"));
    if (isTyping || isReadOnly) return;

    const key = event.key.toLowerCase();
    const hasCommandModifier = event.metaKey || event.ctrlKey;
    if (hasCommandModifier && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoStroke();
      else undoStroke();
      return;
    }
    if (event.ctrlKey && key === "y") {
      event.preventDefault();
      redoStroke();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedStroke) {
        event.preventDefault();
        deleteSelectedStroke();
      } else if (selectedMemo && !editingMemoId) {
        event.preventDefault();
        deleteSelectedMemo();
      }
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const exportCurrentView = (mode: PrintMode) => {
    const now = new Date();
    const timestamp = new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "long",
      timeStyle: "short",
    }).format(now);
    const previousTitle = document.title;
    const restoreTitle = () => {
      setPageTitle(previousTitle);
      setPrintMode("full");
      window.removeEventListener("afterprint", restoreTitle);
    };
    setPageTitle(formatPdfTitle(activeProject?.name, activeYear, now));
    window.addEventListener("afterprint", restoreTitle);
    setPrintMode(mode);
    setPrintTimestamp(timestamp);
    setEditingMemoId("");
    setEraseSelection(null);
    setGroupSelection(null);
    setSelectedGroupUids([]);
    setSelectedStrokeId("");
    eraseSelectionRef.current = null;
    groupSelectionRef.current = null;
    groupDragRef.current = null;
    window.requestAnimationFrame(() => {
      window.setTimeout(() => window.print(), 120);
    });
  };

  const resetProjectView = (projectData: AppData) => {
    setSelectedBurrowUid(projectData.burrows[0]?.uid ?? "");
    setSelectedMemoId("");
    setSelectedGroupUids([]);
    setSelectedStrokeId("");
    setEditingMemoId("");
    setEraseSelection(null);
    setGroupSelection(null);
    eraseSelectionRef.current = null;
    groupSelectionRef.current = null;
    groupDragRef.current = null;
    drawingIdRef.current = null;
    dragRef.current = null;
    setSelectedSex("F");
    setMapMode("select");
    setSearchQuery("");
  };

  const openYear = (year: number) => {
    const projects = workspaceData.projects.filter((project) => project.year === year);
    if (!projects.length) return;
    const storedProjectId = loadActiveProjectId();
    const project = projects.find((item) => item.id === storedProjectId) ?? projects[0];
    setActiveYear(year);
    setActiveProjectId(project.id);
    persistActiveProjectId(project.id);
    setMapHistory([]);
    setMapFuture([]);
    resetProjectView(project.data);
  };

  const createYearPage = (year: number) => {
    if (!Number.isInteger(year) || year < 1900 || year > 2100 || isReadOnly) return;
    if (workspaceData.projects.some((project) => project.year === year)) {
      openYear(year);
      return;
    }
    const project = createProject("区画 1", createEmptyData(), year);
    setWorkspaceData((current) => ({ projects: [...current.projects, project] }));
    setActiveYear(year);
    setActiveProjectId(project.id);
    persistActiveProjectId(project.id);
    setMapHistory([]);
    setMapFuture([]);
    resetProjectView(project.data);
  };

  const returnToYearList = () => {
    setActiveYear(null);
    setMapHistory([]);
    setMapFuture([]);
    setSelectedBurrowUid("");
    setSelectedMemoId("");
    setSelectedGroupUids([]);
    setSelectedStrokeId("");
    setSearchQuery("");
    setProjectSettingsOpen(false);
    setBurrowListOpen(false);
    setPrintChoiceOpen(false);
  };

  const selectProject = (projectId: string) => {
    if (projectId === activeProjectId) return;
    const project = yearProjects.find((item) => item.id === projectId);
    if (!project) return;
    setActiveProjectId(projectId);
    persistActiveProjectId(projectId);
    setProjectSettingsOpen(false);
    setBurrowListOpen(false);
    resetProjectView(project.data);
  };

  const moveProject = (sourceProjectId: string, targetProjectId: string) => {
    if (isReadOnly || sourceProjectId === targetProjectId) return;
    pushHistory();
    setWorkspaceData((current) => {
      const sourceIndex = current.projects.findIndex((project) => project.id === sourceProjectId);
      const targetIndex = current.projects.findIndex((project) => project.id === targetProjectId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const projects = [...current.projects];
      const [sourceProject] = projects.splice(sourceIndex, 1);
      projects.splice(targetIndex, 0, sourceProject);
      return { projects };
    });
  };

  const addProject = () => {
    if (isReadOnly || activeYear === null) return;
    pushHistory();
    const usedNames = new Set(yearProjects.map((project) => project.name));
    let number = yearProjects.length + 1;
    while (usedNames.has(`区画 ${number}`)) number += 1;
    const project = createProject(`区画 ${number}`, createEmptyData(), activeYear);
    setWorkspaceData((current) => ({ projects: [...current.projects, project] }));
    setActiveProjectId(project.id);
    persistActiveProjectId(project.id);
    resetProjectView(project.data);
  };

  const copyActiveProject = () => {
    if (!activeProject || activeYear === null || isReadOnly) return;
    pushHistory();
    const usedNames = new Set(yearProjects.map((project) => project.name));
    const project = createProject(
      createCopyName(activeProject.name, usedNames),
      cloneAppData(activeProject.data),
      activeYear,
    );
    project.note = activeProject.note;
    setWorkspaceData((current) => ({ projects: [...current.projects, project] }));
    setActiveProjectId(project.id);
    persistActiveProjectId(project.id);
    resetProjectView(project.data);
  };

  const renameActiveProject = (name: string) => {
    if (isReadOnly) return;
    setWorkspaceData((current) => ({
      projects: current.projects.map((project) =>
        project.id === activeProjectId
          ? { ...project, name, updatedAt: new Date().toISOString() }
          : project,
      ),
    }));
  };

  const updateActiveProjectNote = (note: string) => {
    if (isReadOnly) return;
    setWorkspaceData((current) => ({
      projects: current.projects.map((project) =>
        project.id === activeProjectId
          ? { ...project, note, updatedAt: new Date().toISOString() }
          : project,
      ),
    }));
  };

  const deleteActiveProject = () => {
    if (!activeProject || yearProjects.length <= 1 || isReadOnly) return;
    if (!window.confirm(`「${activeProject.name}」を削除しますか？`)) return;
    pushHistory();
    const currentIndex = yearProjects.findIndex((project) => project.id === activeProject.id);
    const remainingYearProjects = yearProjects.filter((project) => project.id !== activeProject.id);
    const nextProject = remainingYearProjects[Math.min(currentIndex, remainingYearProjects.length - 1)];
    setWorkspaceData((current) => ({
      projects: current.projects.filter((project) => project.id !== activeProject.id),
    }));
    setActiveProjectId(nextProject.id);
    persistActiveProjectId(nextProject.id);
    resetProjectView(nextProject.data);
  };

  const resetDemo = () => {
    if (isReadOnly) return;
    if (!window.confirm("現在の内容を消して初期例に戻しますか？")) return;
    pushHistory();
    const sample = createSampleData();
    setData(sample);
    setSelectedBurrowUid(sample.burrows[0].uid);
    setSelectedMemoId("");
    setSelectedGroupUids([]);
    setEditingMemoId("");
    setEraseSelection(null);
    setGroupSelection(null);
    eraseSelectionRef.current = null;
    groupSelectionRef.current = null;
    groupDragRef.current = null;
    setSelectedSex("F");
    setMapMode("select");
    setSearchQuery("");
  };

  const visibleGroupBox = groupSelection ? getSelectionBox(groupSelection) : selectedGroupBox;
  const editPasswordDialog = editPasswordOpen ? (
    <EditPasswordDialog
      message={editPasswordMessage}
      onCancel={cancelEditingRequest}
      onPasswordChange={setEditPassword}
      onSubmit={unlockEditing}
      password={editPassword}
      submitting={editPasswordSubmitting}
    />
  ) : null;
  const deleteYearDialog = deleteYearTarget ? (
    <DeleteYearDialog
      message={deleteYearMessage}
      onCancel={cancelYearDeletion}
      onPasswordChange={setDeleteYearPassword}
      onSubmit={confirmYearDeletion}
      password={deleteYearPassword}
      submitting={deleteYearSubmitting}
      summary={deleteYearTarget}
    />
  ) : null;
  const projectSettingsDialog = projectSettingsOpen ? (
    <ProjectSettingsDialog
      isReadOnly={isReadOnly}
      name={activeProject?.name ?? ""}
      note={activeProject?.note ?? ""}
      onClose={() => setProjectSettingsOpen(false)}
      onNameChange={renameActiveProject}
      onNoteChange={updateActiveProjectNote}
    />
  ) : null;
  const printChoiceDialog = printChoiceOpen ? (
    <PrintChoiceDialog
      onCancel={() => setPrintChoiceOpen(false)}
      onSelect={(mode) => {
        setPrintChoiceOpen(false);
        exportCurrentView(mode);
      }}
    />
  ) : null;

  if (!hydrated) {
    return (
      <main className="year-shell">
        <section className="year-panel year-loading" aria-busy="true">
          <p className="eyebrow">Burrow Field Map</p>
          <h1>年ページを読み込み中...</h1>
        </section>
      </main>
    );
  }

  if (activeYear === null || !activeProject) {
    return (
      <>
        <YearSelection
          endingEditing={endingEditing}
          isReadOnly={isReadOnly}
          onCreate={createYearPage}
          onDeleteRequest={requestYearDeletion}
          onFinishEditing={finishEditing}
          onOpen={openYear}
          onRequestEditing={requestEditing}
          summaries={yearSummaries}
        />
        {editPasswordDialog}
        {deleteYearDialog}
      </>
    );
  }

  return (
    <main className={`app-shell print-mode-${printMode} ${isReadOnly ? "read-only" : ""}`}>
      <section className="workspace" aria-label="巣穴管理アプリ">
        <header className="topbar">
          <div className="brand-block">
            <p className="eyebrow">Burrow Field Map</p>
            <h1>巣穴管理 <span className="active-year-label">{activeYear}年</span></h1>
          </div>
          <div className="search-field">
            <label className="sr-only" htmlFor="burrow-search">巣穴を検索</label>
            <input
              id="burrow-search"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="巣穴ID・リング番号・備考を検索"
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button aria-label="検索をクリア" onClick={() => setSearchQuery("")} type="button">×</button>
            ) : null}
          </div>
          <div className="topbar-actions">
            <button className="year-list-button" onClick={returnToYearList} type="button">
              年一覧へ
            </button>
            <button
              aria-pressed={!manualReadOnly}
              className={`read-only-button ${!manualReadOnly ? "active" : ""}`}
              disabled={endingEditing}
              onClick={() => isReadOnly ? requestEditing() : void finishEditing()}
              type="button"
            >
              {endingEditing ? "保存中..." : isReadOnly ? "編集する" : "編集を終了"}
            </button>
            <button className="export-button secondary" onClick={() => setBurrowListOpen(true)} type="button">
              巣穴一覧
            </button>
            <button className="export-button" onClick={() => setPrintChoiceOpen(true)} type="button">
              PDF出力
            </button>
            <div className="status-pill" aria-live="polite">
              <span className="save-dot" />
              {saveState}
            </div>
          </div>
        </header>

        <section className="project-switcher" aria-label="区画プロジェクト">
          <div className="project-tabs" role="tablist" aria-label="区画を切り替え">
            {yearProjects.map((project) => (
              <button
                aria-selected={project.id === activeProjectId}
                className={`${project.id === activeProjectId ? "active" : ""} ${project.id === draggingProjectId ? "dragging" : ""} ${project.id === dragOverProjectId ? "drag-over" : ""}`}
                draggable={!isReadOnly}
                key={project.id}
                onDragEnd={() => {
                  setDraggingProjectId("");
                  setDragOverProjectId("");
                }}
                onDragEnter={(event) => {
                  if (isReadOnly || !draggingProjectId || draggingProjectId === project.id) return;
                  event.preventDefault();
                  setDragOverProjectId(project.id);
                }}
                onDragOver={(event) => {
                  if (isReadOnly || !draggingProjectId || draggingProjectId === project.id) return;
                  event.preventDefault();
                }}
                onDragStart={(event) => {
                  if (isReadOnly) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", project.id);
                  setDraggingProjectId(project.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceProjectId = event.dataTransfer.getData("text/plain") || draggingProjectId;
                  moveProject(sourceProjectId, project.id);
                  setDraggingProjectId("");
                  setDragOverProjectId("");
                }}
                onClick={() => selectProject(project.id)}
                role="tab"
                type="button"
              >
                <span>{project.name || "名称未設定"}</span>
                <small>{project.data.burrows.length}</small>
              </button>
            ))}
            <button className="project-add-button" disabled={isReadOnly} onClick={addProject} type="button">
              <span aria-hidden="true">＋</span> 区画
            </button>
          </div>
          <div className="project-actions">
            <button
              className="project-settings-button"
              onClick={() => {
                if (!isReadOnly) pushHistory();
                setProjectSettingsOpen(true);
              }}
              type="button"
            >
              区画の設定
            </button>
            <button
              className="project-copy-button"
              disabled={!activeProject || isReadOnly}
              onClick={copyActiveProject}
              type="button"
            >
              区画をコピー
            </button>
            <button
              className="project-delete-button"
              disabled={yearProjects.length <= 1 || isReadOnly}
              onClick={deleteActiveProject}
              type="button"
            >
              区画を削除
            </button>
          </div>
        </section>

        <section className="print-project-note-panel" aria-label="選択中の区画メモ">
          <p className="print-project-note">{activeProject?.note || "区画メモなし"}</p>
        </section>

        <p className="print-meta">年: {activeYear} / 区画: {activeProject?.name} / 出力日時: {printTimestamp}</p>

        <section className="summary-grid" aria-label="サマリー">
          <Summary label="巣穴数" value={summary.burrows} />
          <Summary label="合計個体数" value={summary.total} />
          <Summary
            active={summaryHighlightIsActive("female")}
            label="F"
            onClick={() => toggleSummaryHighlight("female")}
            tone="female"
            value={summary.female}
          />
          <Summary
            active={summaryHighlightIsActive("male")}
            label="M"
            onClick={() => toggleSummaryHighlight("male")}
            tone="male"
            value={summary.male}
          />
          <Summary
            active={summaryHighlightIsActive("installed")}
            label="装着済み"
            onClick={() => toggleSummaryHighlight("installed")}
            tone="attached"
            value={summary.installed}
          />
          <Summary
            active={summaryHighlightIsActive("recovered")}
            label="回収済み"
            onClick={() => toggleSummaryHighlight("recovered")}
            tone="recovered"
            value={summary.recovered}
          />
          <Summary
            active={summaryHighlightIsActive("unrecovered")}
            label="未回収"
            onClick={() => toggleSummaryHighlight("unrecovered")}
            tone="unrecovered"
            value={summary.unrecovered}
          />
        </section>

        <div className="main-grid">
          <section className="map-panel" aria-label={isReadOnly ? "読み取り専用の手書き地図" : "編集できる手書き地図"}>
            <div className="map-toolbar">
              <div className="tool-segments" role="toolbar" aria-label="地図編集ツール">
                <ModeButton active={mapMode === "select"} onClick={() => changeMapMode("select")}>
                  選択・移動
                </ModeButton>
                <ModeButton active={mapMode === "group"} disabled={isReadOnly} onClick={() => changeMapMode("group")}> 
                  範囲選択
                </ModeButton>
                <ModeButton active={mapMode === "burrow"} disabled={isReadOnly} onClick={() => changeMapMode("burrow")}>
                  巣穴追加
                </ModeButton>
                <ModeButton active={mapMode === "draw"} disabled={isReadOnly} onClick={() => changeMapMode("draw")}>
                  線を描く
                </ModeButton>
                <ModeButton active={mapMode === "memo"} disabled={isReadOnly} onClick={() => changeMapMode("memo")}>
                  メモ追加
                </ModeButton>
              </div>
              <div className="map-actions">
                <button
                  aria-label="元に戻す"
                  className="icon-text-button"
                  disabled={!mapHistory.length || isReadOnly}
                  onClick={undoStroke}
                  title="元に戻す（Ctrl/Cmd+Z）"
                  type="button"
                >
                  ←
                </button>
                <button
                  aria-label="やり直す"
                  className="icon-text-button"
                  disabled={!mapFuture.length || isReadOnly}
                  onClick={redoStroke}
                  title="やり直す（Ctrl+Y / Ctrl/Cmd+Shift+Z）"
                  type="button"
                >
                  →
                </button>
                <button className="ghost-button" disabled={isReadOnly} onClick={resetDemo} type="button">
                  初期例
                </button>
              </div>
            </div>

            <div
              ref={mapRef}
              className={`paper-map mode-${mapMode}`}
              onContextMenu={(event) => event.preventDefault()}
              onDoubleClick={handleMapDoubleClick}
              onPointerDown={handleMapPointerDown}
              onPointerMove={handleMapPointerMove}
              onPointerUp={finishPointerAction}
              onPointerCancel={finishPointerAction}
              title="範囲選択では巣穴を囲み、表示された枠をドラッグしてまとめて移動できます。"
            >
              <canvas ref={canvasRef} className="drawing-canvas" aria-hidden="true" />
              <svg
                aria-label="地図に描いた線"
                className="stroke-hit-layer"
                preserveAspectRatio="none"
                role="group"
                viewBox="0 0 100 100"
              >
                {data.strokes.map((stroke, index) => (
                  <polyline
                    aria-label={`線${index + 1}を選択`}
                    aria-pressed={stroke.id === selectedStrokeId}
                    className={stroke.id === selectedStrokeId ? "selected" : ""}
                    data-map-control
                    key={stroke.id}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && !isReadOnly && mapMode === "select") {
                        event.preventDefault();
                        setSelectedStrokeId(stroke.id);
                        setSelectedBurrowUid("");
                        setSelectedMemoId("");
                        setSelectedGroupUids([]);
                      }
                    }}
                    onPointerDown={(event) => selectStroke(event, stroke)}
                    points={stroke.points.map((point) => `${point.x},${point.y}`).join(" ")}
                    role="button"
                    tabIndex={mapMode === "select" && !isReadOnly ? 0 : -1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>

              {data.memos.map((memo) =>
                editingMemoId === memo.id ? (
                  <textarea
                    aria-label="地図メモを入力"
                    className="map-memo map-memo-editor selected"
                    data-map-control
                    key={memo.id}
                    onBlur={() => finishMemoEditing(memo.id)}
                    onChange={(event) => updateMemo(event.target.value)}
                    onFocus={pushHistory}
                    readOnly={isReadOnly}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
                        event.currentTarget.blur();
                      }
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    placeholder="メモを入力"
                    ref={memoEditorRef}
                    style={{ left: `${memo.x}%`, top: `${memo.y}%` }}
                    value={memo.text}
                  />
                ) : (
                  <button
                    className={`map-memo ${memo.id === selectedMemo?.id ? "selected" : ""}`}
                    data-map-control
                    key={memo.id}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      if (isReadOnly) return;
                      setSelectedMemoId(memo.id);
                      setSelectedBurrowUid("");
                      setEditingMemoId(memo.id);
                    }}
                    onPointerDown={(event) => selectMemo(event, memo)}
                    style={{ left: `${memo.x}%`, top: `${memo.y}%` }}
                    type="button"
                  >
                    {memo.text || "メモ"}
                  </button>
                ),
              )}

              {eraseSelection ? (
                <div
                  aria-hidden="true"
                  className="erase-selection"
                  style={{
                    left: `${Math.min(eraseSelection.start.x, eraseSelection.current.x)}%`,
                    top: `${Math.min(eraseSelection.start.y, eraseSelection.current.y)}%`,
                    width: `${Math.abs(eraseSelection.current.x - eraseSelection.start.x)}%`,
                    height: `${Math.abs(eraseSelection.current.y - eraseSelection.start.y)}%`,
                  }}
                />
              ) : null}

              {visibleGroupBox ? (
                <div
                  aria-label={`${selectedGroupUids.length}件の巣穴をまとめて移動`}
                  className={`group-selection ${groupSelection ? "selecting" : ""}`}
                  data-map-control
                  onPointerDown={isReadOnly ? undefined : startGroupDrag}
                  role="button"
                  style={{
                    left: `${visibleGroupBox.left}%`,
                    top: `${visibleGroupBox.top}%`,
                    width: `${visibleGroupBox.width}%`,
                    height: `${visibleGroupBox.height}%`,
                  }}
                  tabIndex={0}
                >
                  {!groupSelection && selectedGroupUids.length ? (
                    <span>{selectedGroupUids.length}件</span>
                  ) : null}
                </div>
              ) : null}

              {data.burrows.map((burrow) => {
                return (
                  <button
                    aria-label={`${burrow.label}を選択`}
                    className={`burrow-pin ${burrow.uid === selectedBurrow?.uid || selectedGroupUidSet.has(burrow.uid) ? "selected" : ""} ${selectedGroupUidSet.has(burrow.uid) ? "group-selected" : ""} ${mapHighlightActive && !isBurrowHighlightedOnMap(burrow.uid) ? "search-dimmed" : ""} ${mapHighlightActive && isBurrowHighlightedOnMap(burrow.uid) ? "search-match" : ""}`}
                    data-map-control
                    key={burrow.uid}
                    onPointerDown={(event) => selectBurrow(event, burrow)}
                    style={{ left: `${burrow.x}%`, top: `${burrow.y}%` }}
                    type="button"
                  >
                    <span className="pin-label">{burrow.label}</span>
                    <span className="pin-markers">
                      {(["F", "M"] as Sex[]).map((sex) => (
                        <SexMarker
                          key={sex}
                          registered={burrow.individuals[sex].registered}
                          sex={sex}
                          status={burrow.individuals[sex].loggerStatus}
                        />
                      ))}
                    </span>
                  </button>
                );
              })}

            </div>

            <div className="map-legend" aria-label="地図記号の凡例">
              <span className="legend-pair"><SexMarker registered={false} sex="F" status="none" /> F（丸）</span>
              <span className="legend-pair"><SexMarker registered={false} sex="M" status="none" /> M（四角）</span>
              <span className="legend-pair"><span className="status-swatch status-none" /> 未登録</span>
              <span className="legend-pair"><span className="status-swatch status-attached" /> 装着済</span>
              <span className="legend-pair"><span className="status-swatch status-recovered" /> 回収済</span>
            </div>
          </section>

          <aside className="editor-panel" aria-label="情報入力">
            {selectedStroke ? (
              <>
                <div className="editor-heading">
                  <div>
                    <p className="eyebrow">選択中の線</p>
                    <h2>線オブジェクト</h2>
                  </div>
                  <button className="danger-button" disabled={isReadOnly} type="button" onClick={deleteSelectedStroke}>
                    削除
                  </button>
                </div>
                <p className="field-note">
                  選択中の線は赤色で表示されています。削除ボタン、またはキーボードのDeleteキーで線全体を削除できます。
                </p>
              </>
            ) : selectedMemo ? (
              <>
                <div className="editor-heading">
                  <div>
                    <p className="eyebrow">地図メモ</p>
                    <h2>メモを編集</h2>
                  </div>
                  <button className="danger-button" disabled={isReadOnly} type="button" onClick={deleteSelectedMemo}>
                    削除
                  </button>
                </div>
                <label>
                  メモ内容
                  <textarea
                    readOnly={isReadOnly}
                    value={selectedMemo.text}
                    onChange={(event) => updateMemo(event.target.value)}
                    onFocus={pushHistory}
                  />
                </label>
                <p className="field-note">
                  {isReadOnly
                    ? "読み取り専用のため編集はできません。"
                    : "地図上のメモはドラッグで移動、ダブルクリックで直接編集できます。"}
                </p>
              </>
            ) : selectedBurrow ? (
              <>
                <div className="editor-heading">
                  <div>
                    <p className="eyebrow">選択中の巣穴</p>
                    <h2>{selectedBurrow.label}</h2>
                  </div>
                  <button className="danger-button" disabled={isReadOnly} type="button" onClick={deleteSelectedBurrow}>
                    削除
                  </button>
                </div>

                <label>
                  巣穴ID
                  <input
                    aria-invalid={duplicateBurrowLabel}
                    ref={burrowLabelInputRef}
                    readOnly={isReadOnly}
                    value={selectedBurrow.label}
                    onChange={(event) => updateBurrowLabel(event.target.value)}
                    onFocus={pushHistory}
                  />
                </label>
                {duplicateBurrowLabel ? <p className="warning">同じ巣穴IDがあります。</p> : null}

                <fieldset>
                  <legend>個体</legend>
                  <div className="individual-tabs">
                    {(["F", "M"] as Sex[]).map((sex) => {
                      const individual = selectedBurrow.individuals[sex];
                      return (
                        <button
                          className={selectedSex === sex ? "active" : ""}
                          key={sex}
                          onClick={() => setSelectedSex(sex)}
                          type="button"
                        >
                          <SexMarker registered={individual.registered} sex={sex} status={individual.loggerStatus} />
                          <span><strong>{sex}</strong><small>{individual.registered ? individual.ringNumber || "番号未入力" : "未登録"}</small></span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                {selectedIndividual ? (
                  <div className="individual-form">
                    <label className="checkbox-row">
                      <input
                        checked={selectedIndividual.registered}
                        disabled={isReadOnly}
                        onChange={(event) => updateIndividual({ registered: event.target.checked })}
                        type="checkbox"
                      />
                      {selectedSex} 個体を登録
                    </label>

                    <div className={!selectedIndividual.registered ? "disabled-fields" : ""}>
                      <label>
                        リングナンバー
                        <input
                          disabled={!selectedIndividual.registered || isReadOnly}
                          placeholder="例: R-184"
                          readOnly={isReadOnly}
                          value={selectedIndividual.ringNumber}
                          onChange={(event) => updateIndividual({ ringNumber: event.target.value }, false)}
                          onFocus={pushHistory}
                        />
                      </label>
                      {duplicateRing ? <p className="warning">同じリングナンバーがあります。</p> : null}

                      <fieldset disabled={!selectedIndividual.registered || isReadOnly}>
                        <legend>ロガー状態</legend>
                        <div className="status-segments">
                          {(Object.keys(loggerLabels) as LoggerStatus[]).map((status) => (
                            <button
                              className={selectedIndividual.loggerStatus === status ? "active" : ""}
                              disabled={isReadOnly}
                              key={status}
                              onClick={() => updateIndividual({ loggerStatus: status })}
                              type="button"
                            >
                              <span className={`status-swatch status-${status}`} />
                              {loggerLabels[status]}
                            </button>
                          ))}
                        </div>
                      </fieldset>

                      <div className="date-grid">
                        <label>
                          装着日
                          <input
                            disabled={!selectedIndividual.registered || isReadOnly}
                            readOnly={isReadOnly}
                            type="date"
                            value={selectedIndividual.attachedDate}
                            onChange={(event) => updateIndividual({ attachedDate: event.target.value })}
                          />
                        </label>
                        <label>
                          回収日
                          <input
                            disabled={!selectedIndividual.registered || isReadOnly}
                            readOnly={isReadOnly}
                            type="date"
                            value={selectedIndividual.recoveredDate}
                            onChange={(event) => updateIndividual({ recoveredDate: event.target.value })}
                          />
                        </label>
                      </div>
                      {invalidRecovery ? <p className="warning">回収日が装着日より前です。</p> : null}
                    </div>
                  </div>
                ) : null}

                <label>
                  巣穴の備考
                  <textarea
                    placeholder="入口の向き、周辺目印、観察メモなど"
                    readOnly={isReadOnly}
                    value={selectedBurrow.notes}
                    onChange={(event) => updateBurrow({ notes: event.target.value })}
                    onFocus={pushHistory}
                  />
                </label>
              </>
            ) : (
              <div className="empty-state">
                <h2>巣穴を追加</h2>
                <p>「巣穴追加」を選び、地図上にポイントを置いてください。</p>
              </div>
            )}
          </aside>
        </div>

        {burrowListOpen ? (
        <div className="utility-overlay" role="presentation">
        <section aria-labelledby="burrow-list-title" aria-modal="true" className="list-panel list-dialog" role="dialog">
          <div className="list-heading">
            <div>
              <h2 id="burrow-list-title">巣穴一覧</h2>
              <span>
                {normalizedSearch || hasListFilters
                  ? `${filteredBurrows.length} / ${data.burrows.length}件`
                  : `${data.burrows.length}件`}
              </span>
            </div>
            <button
              aria-label="巣穴一覧を閉じる"
              className="dialog-close-button"
              onClick={() => setBurrowListOpen(false)}
              type="button"
            >
              閉じる
            </button>
            <button
              className="filter-reset-button"
              disabled={!hasListFilters && burrowSortKey === "label-asc" && filterMatchMode === "and"}
              onClick={() => {
                setListFilters(createEmptyListFilters());
                setBurrowSortKey("label-asc");
                setFilterMatchMode("and");
              }}
              type="button"
            >
              条件をクリア
            </button>
            <div className="match-mode-control" aria-label="検索方式">
              <span>検索方式</span>
              {(Object.keys(filterMatchModeLabels) as FilterMatchMode[]).map((mode) => (
                <button
                  aria-pressed={filterMatchMode === mode}
                  className={filterMatchMode === mode ? "active" : ""}
                  key={mode}
                  onClick={() => setFilterMatchMode(mode)}
                  type="button"
                >
                  {filterMatchModeLabels[mode]}
                </button>
              ))}
            </div>
          </div>
          <div className="table-filters" aria-label="巣穴一覧の絞り込みと並び替え">
            <label>
              <span>巣穴ID</span>
              <input
                onChange={(event) => setListFilters((current) => ({ ...current, label: event.target.value }))}
                placeholder="IDで絞り込み"
                value={listFilters.label}
              />
            </label>
            <label>
              <span>F 個体</span>
              <select
                onChange={(event) =>
                  setListFilters((current) => ({ ...current, female: event.target.value as IndividualFilter }))
                }
                value={listFilters.female}
              >
                {(Object.keys(individualFilterLabels) as IndividualFilter[]).map((key) => (
                  <option key={key} value={key}>
                    {individualFilterLabels[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>M 個体</span>
              <select
                onChange={(event) =>
                  setListFilters((current) => ({ ...current, male: event.target.value as IndividualFilter }))
                }
                value={listFilters.male}
              >
                {(Object.keys(individualFilterLabels) as IndividualFilter[]).map((key) => (
                  <option key={key} value={key}>
                    {individualFilterLabels[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>装着日</span>
              <div className="date-filter-pair">
                <input
                  aria-label="装着日の開始日"
                  onChange={(event) => setListFilters((current) => ({ ...current, attachedFrom: event.target.value }))}
                  type="date"
                  value={listFilters.attachedFrom}
                />
                <span className="date-range-separator" aria-hidden="true">〜</span>
                <input
                  aria-label="装着日の終了日"
                  onChange={(event) => setListFilters((current) => ({ ...current, attachedTo: event.target.value }))}
                  type="date"
                  value={listFilters.attachedTo}
                />
              </div>
            </label>
            <label>
              <span>回収日</span>
              <div className="date-filter-pair">
                <input
                  aria-label="回収日の開始日"
                  onChange={(event) => setListFilters((current) => ({ ...current, recoveredFrom: event.target.value }))}
                  type="date"
                  value={listFilters.recoveredFrom}
                />
                <span className="date-range-separator" aria-hidden="true">〜</span>
                <input
                  aria-label="回収日の終了日"
                  onChange={(event) => setListFilters((current) => ({ ...current, recoveredTo: event.target.value }))}
                  type="date"
                  value={listFilters.recoveredTo}
                />
              </div>
            </label>
            <label>
              <span>備考</span>
              <input
                onChange={(event) => setListFilters((current) => ({ ...current, notes: event.target.value }))}
                placeholder="備考で絞り込み"
                value={listFilters.notes}
              />
            </label>
            <label>
              <span>並び替え</span>
              <select
                aria-label="巣穴一覧の並び替え"
                onChange={(event) => setBurrowSortKey(event.target.value as BurrowSortKey)}
                value={burrowSortKey}
              >
                {(Object.keys(sortLabels) as BurrowSortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {sortLabels[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>巣穴ID</th>
                  <th>F 個体</th>
                  <th>M 個体</th>
                  <th>備考</th>
                </tr>
              </thead>
              <tbody>
                {sortedFilteredBurrows.map((burrow) => (
                  <tr
                    className={burrow.uid === selectedBurrow?.uid ? "active" : ""}
                    key={burrow.uid}
                    onClick={() => {
                      setSelectedBurrowUid(burrow.uid);
                      setSelectedMemoId("");
                      setSelectedStrokeId("");
                    }}
                  >
                    <td><strong>{burrow.label}</strong></td>
                    <td><IndividualCell individual={burrow.individuals.F} sex="F" /></td>
                    <td><IndividualCell individual={burrow.individuals.M} sex="M" /></td>
                    <td className="notes-cell">{burrow.notes || "-"}</td>
                  </tr>
                ))}
                {!filteredBurrows.length ? (
                  <tr className="no-results">
                    <td colSpan={4}>該当する巣穴がありません</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
        </div>
        ) : null}

        <section className="print-target-list" aria-label="装着・回収対象一覧">
          <h2>装着・回収対象一覧</h2>
          <div className="print-target-grid">
            <PrintTargetTable rows={printTargets.attachment} title="装着対象" />
            <PrintTargetTable rows={printTargets.recovery} title="回収対象" />
          </div>
        </section>
      </section>
      {editPasswordDialog}
      {projectSettingsDialog}
      {printChoiceDialog}
    </main>
  );
}

function EditPasswordDialog({
  message,
  onCancel,
  onPasswordChange,
  onSubmit,
  password,
  submitting,
}: {
  message: string;
  onCancel: () => void;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  password: string;
  submitting: boolean;
}) {
  return (
    <div className="edit-password-overlay" role="presentation">
      <section aria-labelledby="edit-password-title" aria-modal="true" className="edit-password-dialog" role="dialog">
        <p className="eyebrow">編集モード</p>
        <h2 id="edit-password-title">パスワードを入力</h2>
        <p>閲覧はそのまま可能です。編集する場合だけパスワードが必要です。</p>
        <form onSubmit={onSubmit}>
          <label htmlFor="edit-password">パスワード</label>
          <input
            autoComplete="current-password"
            autoFocus
            id="edit-password"
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="パスワードを入力"
            type="password"
            value={password}
          />
          {message ? <p className="password-error" role="alert">{message}</p> : null}
          <div className="edit-password-actions">
            <button className="edit-password-cancel" disabled={submitting} onClick={onCancel} type="button">キャンセル</button>
            <button disabled={!password || submitting} type="submit">
              {submitting ? "確認中..." : "編集を開始"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ProjectSettingsDialog({
  isReadOnly,
  name,
  note,
  onClose,
  onNameChange,
  onNoteChange,
}: {
  isReadOnly: boolean;
  name: string;
  note: string;
  onClose: () => void;
  onNameChange: (name: string) => void;
  onNoteChange: (note: string) => void;
}) {
  return (
    <div className="utility-overlay" role="presentation">
      <section aria-labelledby="project-settings-title" aria-modal="true" className="utility-dialog" role="dialog">
        <div className="utility-dialog-heading">
          <div>
            <p className="eyebrow">選択中の区画</p>
            <h2 id="project-settings-title">区画の設定</h2>
          </div>
          <button className="dialog-close-button" onClick={onClose} type="button">閉じる</button>
        </div>
        <label>
          区画の名前
          <input
            autoFocus
            onBlur={(event) => onNameChange(event.target.value.trim() || "名称未設定")}
            onChange={(event) => onNameChange(event.target.value)}
            readOnly={isReadOnly}
            value={name}
          />
        </label>
        <label>
          区画メモ
          <textarea
            maxLength={1200}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="例：バイオロギング用の区画"
            readOnly={isReadOnly}
            rows={6}
            value={note}
          />
        </label>
        {isReadOnly ? <p className="field-note">編集する場合は、先に編集モードを開始してください。</p> : null}
      </section>
    </div>
  );
}

function PrintChoiceDialog({
  onCancel,
  onSelect,
}: {
  onCancel: () => void;
  onSelect: (mode: PrintMode) => void;
}) {
  return (
    <div className="utility-overlay" role="presentation">
      <section aria-labelledby="print-choice-title" aria-modal="true" className="utility-dialog print-choice-dialog" role="dialog">
        <div className="utility-dialog-heading">
          <div>
            <p className="eyebrow">PDF出力</p>
            <h2 id="print-choice-title">出力内容を選択</h2>
          </div>
          <button className="dialog-close-button" onClick={onCancel} type="button">閉じる</button>
        </div>
        <div className="print-choice-actions">
          <button onClick={() => onSelect("full")} type="button">
            <strong>マップと一覧表</strong>
            <span>地図と装着・回収対象の一覧を出力</span>
          </button>
          <button onClick={() => onSelect("map")} type="button">
            <strong>マップ</strong>
            <span>地図だけを出力</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function PrintTargetTable({
  rows,
  title,
}: {
  rows: Array<{ burrowLabel: string; sex: Sex; individual: Individual }>;
  title: string;
}) {
  return (
    <section>
      <h3>{title}</h3>
      <table>
        <thead>
          <tr>
            <th>巣穴ID</th>
            <th>対象個体の雌雄</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.burrowLabel}-${row.sex}`}>
              <td>{row.burrowLabel}</td>
              <td>{row.sex}</td>
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td colSpan={2}>対象なし</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function DeleteYearDialog({
  message,
  onCancel,
  onPasswordChange,
  onSubmit,
  password,
  submitting,
  summary,
}: {
  message: string;
  onCancel: () => void;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  password: string;
  submitting: boolean;
  summary: YearSummary;
}) {
  return (
    <div className="edit-password-overlay" role="presentation">
      <section
        aria-labelledby="delete-year-title"
        aria-modal="true"
        className="edit-password-dialog delete-year-dialog"
        role="alertdialog"
      >
        <p className="eyebrow delete-year-eyebrow">削除の確認</p>
        <h2 id="delete-year-title">{summary.year}年ページを削除</h2>
        <p className="delete-year-warning">
          この年に含まれる{summary.projects}区画・巣穴{summary.burrows}件と地図の内容をすべて削除します。この操作は元に戻せません。
        </p>
        <form onSubmit={onSubmit}>
          <label htmlFor="delete-year-password">確認のためパスワードを再入力</label>
          <input
            autoComplete="current-password"
            autoFocus
            id="delete-year-password"
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="パスワードを入力"
            type="password"
            value={password}
          />
          {message ? <p className="password-error" role="alert">{message}</p> : null}
          <div className="edit-password-actions">
            <button className="edit-password-cancel" disabled={submitting} onClick={onCancel} type="button">
              キャンセル
            </button>
            <button className="delete-year-confirm" disabled={!password || submitting} type="submit">
              {submitting ? "確認中..." : "パスワードを確認して削除"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function YearSelection({
  endingEditing,
  isReadOnly,
  onCreate,
  onDeleteRequest,
  onFinishEditing,
  onOpen,
  onRequestEditing,
  summaries,
}: {
  endingEditing: boolean;
  isReadOnly: boolean;
  onCreate: (year: number) => void;
  onDeleteRequest: (summary: YearSummary) => void;
  onFinishEditing: () => Promise<void>;
  onOpen: (year: number) => void;
  onRequestEditing: () => void;
  summaries: YearSummary[];
}) {
  const [yearValue, setYearValue] = useState(String(CURRENT_YEAR));
  const year = Number(yearValue);
  const yearIsValid = Number.isInteger(year) && year >= 1900 && year <= 2100;
  const existingYear = summaries.some((summary) => summary.year === year);

  const submit = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!yearIsValid || isReadOnly) return;
    onCreate(year);
  };

  return (
    <main className="year-shell">
      <section className="year-panel" aria-label="年ページを選択">
        <header className="year-heading">
          <div>
            <p className="eyebrow">Burrow Field Map</p>
            <h1>年ページを選択</h1>
            <p>記録を確認・編集する年を選んでください。</p>
          </div>
          <button
            className={`read-only-button ${!isReadOnly ? "active" : ""}`}
            disabled={endingEditing}
            onClick={() => isReadOnly ? onRequestEditing() : void onFinishEditing()}
            type="button"
          >
            {endingEditing ? "保存中..." : isReadOnly ? "編集する" : "編集を終了"}
          </button>
        </header>

        <div className="year-grid">
          {summaries.map((summary) => (
            <article className="year-card" key={summary.year}>
              <button className="year-card-open" onClick={() => onOpen(summary.year)} type="button">
                <strong>{summary.year}<span>年</span></strong>
                <span>{summary.projects}区画・巣穴{summary.burrows}件</span>
                <small>
                  最終更新 {new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(summary.updatedAt))}
                </small>
              </button>
              {!isReadOnly ? (
                <button
                  aria-label={`${summary.year}年ページを削除`}
                  className="year-delete-button"
                  onClick={() => onDeleteRequest(summary)}
                  type="button"
                >
                  年ページを削除
                </button>
              ) : null}
            </article>
          ))}
        </div>

        <form className="year-create-form" onSubmit={submit}>
          <div>
            <label htmlFor="new-year">新しい年ページ</label>
            <p>{isReadOnly ? "読み取り専用では新規作成できません。" : "年を入力すると、空の区画を1つ作成します。"}</p>
          </div>
          <input
            aria-describedby="year-create-note"
            id="new-year"
            inputMode="numeric"
            max="2100"
            min="1900"
            onChange={(event) => setYearValue(event.target.value)}
            type="number"
            value={yearValue}
          />
          <button disabled={!yearIsValid || isReadOnly} type="submit">
            {existingYear ? "この年を開く" : "年ページを作成"}
          </button>
          <span className="sr-only" id="year-create-note">1900年から2100年まで入力できます。</span>
        </form>
      </section>
    </main>
  );
}

function ModeButton({
  active,
  children,
  disabled = false,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={active ? "active" : ""}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Summary({
  active = false,
  label,
  onClick,
  value,
  tone = "default",
}: {
  active?: boolean;
  label: string;
  onClick?: () => void;
  value: number;
  tone?: "default" | "female" | "male" | "attached" | "recovered" | "unrecovered";
}) {
  if (onClick) {
    return (
      <button
        aria-pressed={active}
        className={`summary-item summary-button tone-${tone} ${active ? "active" : ""}`}
        onClick={onClick}
        title={`${label}の巣穴を地図で強調`}
        type="button"
      >
        <span>{label}</span>
        <strong>{value}</strong>
      </button>
    );
  }

  return (
    <article className={`summary-item tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SexMarker({
  sex,
  status,
  registered = true,
}: {
  sex: Sex;
  status: LoggerStatus;
  registered?: boolean;
}) {
  const stateLabel = registered ? loggerLabels[status] : "未登録";
  return (
    <span
      aria-label={`${sex}・${stateLabel}`}
      className={`sex-marker sex-${sex.toLowerCase()} status-${status} ${registered ? "" : "state-unregistered"}`}
      role="img"
    />
  );
}

function IndividualCell({ individual, sex }: { individual: Individual; sex: Sex }) {
  if (!individual.registered) {
    return (
      <span className="individual-cell">
        <SexMarker registered={false} sex={sex} status="none" />
        <span className="unregistered">未登録</span>
      </span>
    );
  }
  return (
    <span className="individual-cell">
      <SexMarker sex={sex} status={individual.loggerStatus} />
      <span>
        <strong>{individual.ringNumber || "番号未入力"}</strong>
        <small>{loggerLabels[individual.loggerStatus]}</small>
      </span>
    </span>
  );
}
