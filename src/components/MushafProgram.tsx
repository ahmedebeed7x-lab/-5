import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookmarkCheck,
  BookMarked,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Eye,
  EyeOff,
  Highlighter,
  LocateFixed,
  Maximize2,
  Minimize2,
  MousePointer,
  Palette,
  PenTool,
  Plus,
  ScanEye,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { MushafLineRow, type MushafLetterUnit, type MushafLineItem } from './MushafLineRow';
import {
  MushafTeacherOverlay,
  type TeacherDrawTool,
  type TeacherStroke,
} from './MushafTeacherOverlay';
import { analyzeWordTajweed, TAJWEED_LEGEND } from '../utils/tajweedRules';
import {
  DIACRITIC_RE,
  INITIAL_MUSHAF_SURAHS,
  TOTAL_MUSHAF_PAGES,
  toArabicDigits,
  tokenizeMushafText,
  type MushafDataset,
  type MushafRawPage,
  type MushafSurahMeta,
  type TokenizedMushafPage,
  type TokenizedMushafRow,
} from '../utils/mushafData';

export interface MushafPracticeConfig {
  targetLetters: string[];
  targetLabel: string;
  hitMessage?: string;
  missMessage?: string;
  completeSingleMessage?: string;
  onPracticeComplete?: () => void;
}

export interface MushafProgramProps {
  variant?: 'standalone' | 'embedded';
  initialPage?: number;
  initialTajweed?: boolean;
  isPresentationMode?: boolean;
  onTogglePresentationMode?: () => void;
  practiceConfig?: MushafPracticeConfig;
  onPlayChime?: (success: boolean) => void;
  onTriggerConfetti?: () => void;
}

const MUSHAF_ZOOM_STEPS = [0.85, 1, 1.15, 1.3, 1.45] as const;
const BOOKMARKS_STORAGE_KEY = 'talakah_mushaf_bookmarks_v1';
const TEACHER_PEN_COLORS = [
  { id: 'red', hex: '#DC2626', label: 'أحمر للتنبيه' },
  { id: 'blue', hex: '#0047FF', label: 'أزرق للشرح' },
  { id: 'green', hex: '#059669', label: 'أخضر للإجادة' },
] as const;

interface MushafBookmark {
  id: string;
  pageNum: number;
  surahName: string;
  surahId?: number;
  ayahNum?: number;
  label: string;
  createdAt: number;
}

function loadSavedBookmarks(): MushafBookmark[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const MushafProgram: React.FC<MushafProgramProps> = ({
  variant = 'standalone',
  initialPage = 1,
  initialTajweed = true,
  isPresentationMode = false,
  onTogglePresentationMode,
  practiceConfig,
  onPlayChime,
  onTriggerConfetti,
}) => {
  const hasPractice = !!practiceConfig && practiceConfig.targetLetters.length > 0;
  const targetLetters = practiceConfig?.targetLetters ?? [];
  const targetLettersKey = targetLetters.join(',');

  const [mushafDataset, setMushafDataset] = useState<MushafDataset | null>(null);
  const [selectedSurah, setSelectedSurah] = useState('الفاتحة');
  const [currentMushafPage, setCurrentMushafPage] = useState(initialPage);
  const [mushafMode, setMushafMode] = useState<'practice' | 'reading'>(
    hasPractice ? 'practice' : 'reading'
  );
  const [mushafTajweed, setMushafTajweed] = useState(initialTajweed);
  const [surahCorrectMap, setSurahCorrectMap] = useState<Record<string, boolean>>({});
  const [surahRevealed, setSurahRevealed] = useState(false);
  const [surahStatus, setSurahStatus] = useState<{ msg: string; kind: 'ok' | 'bad' | null }>({
    msg: '',
    kind: null,
  });
  const [surahWrongKey, setSurahWrongKey] = useState<string | null>(null);
  const [mushafZoom, setMushafZoom] = useState<number>(1);
  const [pageTurn, setPageTurn] = useState<{ dir: 'next' | 'prev'; seq: number } | null>(null);
  const turnSeqRef = useRef(0);

  // Interactive online teacher tools
  const [isTeacherDockOpen, setIsTeacherDockOpen] = useState(false);
  const [teacherTool, setTeacherTool] = useState<TeacherDrawTool>('cursor');
  const [teacherPenColor, setTeacherPenColor] = useState<string>('#DC2626');
  const [strokesByPage, setStrokesByPage] = useState<Record<number, TeacherStroke[]>>({});
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [focusedAyahKey, setFocusedAyahKey] = useState<string | null>(null);
  const [isHifzHidden, setIsHifzHidden] = useState(false);
  const [revealedWordKeys, setRevealedWordKeys] = useState<Record<string, boolean>>({});
  const [revealedAyahKeys, setRevealedAyahKeys] = useState<Record<string, boolean>>({});
  const [bookmarks, setBookmarks] = useState<MushafBookmark[]>(() => loadSavedBookmarks());
  const [isBookmarksOpen, setIsBookmarksOpen] = useState(false);
  const [bookmarkNoteInput, setBookmarkNoteInput] = useState('');

  const zoomStepIdx = MUSHAF_ZOOM_STEPS.findIndex((z) => Math.abs(z - mushafZoom) < 0.01);
  const resolvedZoomIdx = zoomStepIdx >= 0 ? zoomStepIdx : 1;
  const canZoomOut = resolvedZoomIdx > 0;
  const canZoomIn = resolvedZoomIdx < MUSHAF_ZOOM_STEPS.length - 1;
  const handleStepZoom = (delta: -1 | 1) => {
    const nextIdx = Math.max(0, Math.min(MUSHAF_ZOOM_STEPS.length - 1, resolvedZoomIdx + delta));
    setMushafZoom(MUSHAF_ZOOM_STEPS[nextIdx]);
  };

  useEffect(() => {
    setMushafMode(hasPractice ? 'practice' : 'reading');
    setSurahCorrectMap({});
    setSurahRevealed(false);
    setSurahStatus({ msg: '', kind: null });
  }, [hasPractice, targetLettersKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/mushaf_pages_v18.json', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed to load Mushaf dataset'))))
      .then((data: MushafDataset) => {
        if (
          data &&
          Array.isArray(data.surahs) &&
          Array.isArray(data.pages) &&
          data.pages.length === TOTAL_MUSHAF_PAGES
        ) {
          setMushafDataset(data);
        }
      })
      .catch(() => {
        // Ignore abort/offline errors
      });
    return () => controller.abort();
  }, []);

  const mushafSurahs = mushafDataset?.surahs || INITIAL_MUSHAF_SURAHS;

  const surahMetaMap = useMemo(() => {
    const map = new Map<number, MushafSurahMeta>();
    for (const s of mushafSurahs) {
      map.set(s.id, s);
    }
    return map;
  }, [mushafSurahs]);

  const clampedMushafPage = Math.max(1, Math.min(TOTAL_MUSHAF_PAGES, currentMushafPage));

  const getPageSurahNames = (rawPage: MushafRawPage | undefined): string[] => {
    if (!rawPage) return [];
    const names: string[] = [];
    for (const row of rawPage.rows) {
      if (row.k === 't' && row.r) {
        for (const run of row.r) {
          const meta = surahMetaMap.get(run.s);
          if (meta && !names.includes(meta.name)) {
            names.push(meta.name);
          }
        }
      }
    }
    if (names.length === 0) {
      for (const row of rawPage.rows) {
        if (row.s) {
          const meta = surahMetaMap.get(row.s);
          if (meta && !names.includes(meta.name)) {
            names.push(meta.name);
          }
        }
      }
    }
    return names;
  };

  const buildTokenizedPage = (pageNum: number): TokenizedMushafPage | null => {
    const rawPage = mushafDataset?.pages[pageNum - 1];
    if (!rawPage) return null;

    const surahNames = getPageSurahNames(rawPage);
    const rows: TokenizedMushafRow[] = [];

    for (const row of rawPage.rows) {
      if (row.k === 'b' && row.s) {
        const surahMeta = surahMetaMap.get(row.s);
        if (surahMeta) {
          rows.push({ kind: 'banner', line: row.l, surahMeta });
        }
        continue;
      }

      if (row.k === 'm' && row.s) {
        rows.push({ kind: 'basmalah', line: row.l, surahId: row.s });
        continue;
      }

      if (row.k === 't' && row.r) {
        const items: MushafLineItem[] = [];
        let endCount = 0;
        const plainParts: string[] = [];

        row.r.forEach((run, runIdx) => {
          const hasRubMarker = run.t.startsWith('\u00A0') && !run.t.includes('\u06DE');
          const clean = run.t.replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
          const words = clean ? clean.split(/[\s\u00A0]+/) : [];
          if (run.e === 1) endCount++;

          if (words.length === 0) {
            if (run.e === 1) {
              items.push({
                kind: 'rosette',
                keyPrefix: `${pageNum}_${row.l}_${runIdx}_end`,
                ayahNum: run.a,
                surahId: run.s,
              });
            }
            return;
          }

          plainParts.push(clean);
          words.forEach((word, wIdx) => {
            const isFirstWordOfRun = wIdx === 0;
            const isLastWordOfRun = wIdx === words.length - 1;
            const rawWithRub = isFirstWordOfRun && hasRubMarker ? `\u06DE${word}` : word;
            items.push({
              kind: 'word',
              keyPrefix: `${pageNum}_${row.l}_${runIdx}_${wIdx}`,
              rawWord: rawWithRub,
              tokens: tokenizeMushafText(rawWithRub, targetLetters),
              ayahEnd: isLastWordOfRun && run.e === 1 ? run.a : null,
              surahId: run.s,
              ayahNum: run.a,
            });
          });
        });

        const lastRun = row.r[row.r.length - 1];
        const lastSurahMeta = lastRun ? surahMetaMap.get(lastRun.s) : undefined;
        const isSurahEnd = !!(
          lastRun &&
          lastRun.e === 1 &&
          lastSurahMeta &&
          lastRun.a === lastSurahMeta.totalAyat
        );
        const baseTextLen =
          plainParts.join(' ').replace(new RegExp(DIACRITIC_RE.source, 'g'), '').length + endCount * 3;
        const isClosingPairRow = pageNum === 604 && row.l === 14;
        const isCentered = pageNum <= 2 || isClosingPairRow || (isSurahEnd && baseTextLen < 36);

        rows.push({
          kind: 'text',
          line: row.l,
          isCentered,
          items,
        });
      }
    }

    const flatWords: Array<Extract<MushafLineItem, { kind: 'word' }>> = [];
    for (const r of rows) {
      if (r.kind === 'text') {
        for (const item of r.items) {
          if (item.kind === 'word') {
            flatWords.push(item);
          }
        }
      }
    }

    let prevPageLastWord:
      | { surahId: number; ayahNum: number; tokens: MushafLetterUnit[] }
      | undefined;
    const prevRawPage = pageNum > 1 ? mushafDataset?.pages[pageNum - 2] : undefined;
    if (prevRawPage) {
      for (let rIdx = prevRawPage.rows.length - 1; rIdx >= 0; rIdx--) {
        const pr = prevRawPage.rows[rIdx];
        if (pr.k === 't' && pr.r && pr.r.length > 0) {
          const lastRun = pr.r[pr.r.length - 1];
          if (lastRun.e === 1) break;
          const clean = lastRun.t.replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
          const words = clean ? clean.split(/[\s\u00A0]+/) : [];
          if (words.length > 0) {
            prevPageLastWord = {
              surahId: lastRun.s,
              ayahNum: lastRun.a,
              tokens: tokenizeMushafText(words[words.length - 1], targetLetters),
            };
          }
          break;
        }
        if (pr.k === 'b' || pr.k === 'm') break;
      }
    }

    let nextPageFirstWord:
      | { surahId: number; ayahNum: number; tokens: MushafLetterUnit[] }
      | undefined;
    const nextRawPage = pageNum < TOTAL_MUSHAF_PAGES ? mushafDataset?.pages[pageNum] : undefined;
    if (nextRawPage) {
      for (const nr of nextRawPage.rows) {
        if (nr.k === 'b' || nr.k === 'm') break;
        if (nr.k === 't' && nr.r) {
          for (const nRun of nr.r) {
            const clean = nRun.t.replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, '');
            const words = clean ? clean.split(/[\s\u00A0]+/) : [];
            if (words.length > 0) {
              nextPageFirstWord = {
                surahId: nRun.s,
                ayahNum: nRun.a,
                tokens: tokenizeMushafText(words[0], targetLetters),
              };
              break;
            }
          }
        }
        if (nextPageFirstWord) break;
      }
    }

    flatWords.forEach((wordItem, idx) => {
      const isFirstOnPage = idx === 0;
      const isLastOnPage = idx === flatWords.length - 1;
      const prevWord = idx > 0 ? flatWords[idx - 1] : undefined;
      const prevWordTokens = isFirstOnPage
        ? prevPageLastWord &&
          prevPageLastWord.surahId === wordItem.surahId &&
          prevPageLastWord.ayahNum === wordItem.ayahNum
          ? prevPageLastWord.tokens
          : undefined
        : prevWord &&
          prevWord.ayahEnd === null &&
          prevWord.surahId === wordItem.surahId &&
          prevWord.ayahNum === wordItem.ayahNum
        ? prevWord.tokens
        : undefined;
      const nextWord = idx < flatWords.length - 1 ? flatWords[idx + 1] : undefined;
      const sameNextAyahOnPage = !!(
        nextWord &&
        nextWord.surahId === wordItem.surahId &&
        nextWord.ayahNum === wordItem.ayahNum
      );
      const nextWordTokens =
        wordItem.ayahEnd !== null
          ? undefined
          : isLastOnPage
          ? nextPageFirstWord &&
            nextPageFirstWord.surahId === wordItem.surahId &&
            nextPageFirstWord.ayahNum === wordItem.ayahNum
            ? nextPageFirstWord.tokens
            : undefined
          : sameNextAyahOnPage
          ? nextWord!.tokens
          : undefined;
      const isAyahEndBoundary =
        wordItem.ayahEnd !== null || (!isLastOnPage && !sameNextAyahOnPage);
      wordItem.tajweed = analyzeWordTajweed(wordItem.tokens, {
        prevWordTokens,
        nextWordTokens,
        isAyahEnd: isAyahEndBoundary,
      });
    });

    return {
      pageNum,
      jozz: rawPage.j,
      surahNames,
      rows,
    };
  };

  const activeSinglePageData = useMemo(
    () => buildTokenizedPage(clampedMushafPage),
    [mushafDataset, surahMetaMap, clampedMushafPage, targetLettersKey]
  );

  const visiblePagesData = useMemo(
    () => [activeSinglePageData],
    [activeSinglePageData]
  );

  const currentJozz = activeSinglePageData?.jozz || 1;
  const currentSurahIdx = Math.max(0, mushafSurahs.findIndex((s) => s.name === selectedSurah));
  const currentSurahEntry = mushafSurahs[currentSurahIdx] || mushafSurahs[0];

  const pageAyahList = useMemo(() => {
    if (!activeSinglePageData) return [];
    const seen = new Set<string>();
    const list: Array<{ key: string; surahId: number; ayahNum: number; surahName: string }> = [];
    for (const row of activeSinglePageData.rows) {
      if (row.kind !== 'text') continue;
      for (const item of row.items) {
        const key = `${item.surahId}:${item.ayahNum}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({
            key,
            surahId: item.surahId,
            ayahNum: item.ayahNum,
            surahName: surahMetaMap.get(item.surahId)?.name || '',
          });
        }
      }
    }
    return list;
  }, [activeSinglePageData, surahMetaMap]);

  const currentPageStrokes = strokesByPage[clampedMushafPage] || [];
  const currentPageBookmark = useMemo(
    () => bookmarks.find((bm) => bm.pageNum === clampedMushafPage),
    [bookmarks, clampedMushafPage]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
    } catch {
      // Ignore storage quota issues
    }
  }, [bookmarks]);

  const surahTotalTargets = useMemo(() => {
    if (!hasPractice) return 0;
    let count = 0;
    for (const pageData of visiblePagesData) {
      if (!pageData) continue;
      for (const row of pageData.rows) {
        if (row.kind !== 'text') continue;
        for (const item of row.items) {
          if (item.kind !== 'word') continue;
          for (const t of item.tokens) {
            if (t.type === 'letter' && t.isTarget) count++;
          }
        }
      }
    }
    return count;
  }, [hasPractice, visiblePagesData]);

  const surahFoundCount = useMemo(() => {
    if (!hasPractice) return 0;
    let count = 0;
    for (const pageData of visiblePagesData) {
      if (!pageData) continue;
      for (const row of pageData.rows) {
        if (row.kind !== 'text') continue;
        for (const item of row.items) {
          if (item.kind !== 'word') continue;
          for (let tIdx = 0; tIdx < item.tokens.length; tIdx++) {
            const key = `${item.keyPrefix}_${tIdx}`;
            if (item.tokens[tIdx].isTarget && surahCorrectMap[key]) count++;
          }
        }
      }
    }
    return count;
  }, [hasPractice, visiblePagesData, surahCorrectMap]);

  const handleSelectSurah = (name: string) => {
    const target = mushafSurahs.find((s) => s.name === name);
    setSelectedSurah(name);
    if (target) {
      setCurrentMushafPage(target.startPage);
    }
    setSurahRevealed(false);
    setSurahStatus({ msg: '', kind: null });
    setFocusedAyahKey(null);
    setRevealedWordKeys({});
    setRevealedAyahKeys({});
  };

  const handleJumpToPage = (pageNum: number) => {
    const clampedPage = Math.max(1, Math.min(TOTAL_MUSHAF_PAGES, pageNum));
    setCurrentMushafPage(clampedPage);
    const pNames = getPageSurahNames(mushafDataset?.pages[clampedPage - 1]);
    if (pNames[0]) {
      setSelectedSurah(pNames[0]);
    }
    setSurahRevealed(false);
    setSurahStatus({ msg: '', kind: null });
    setFocusedAyahKey(null);
    setRevealedWordKeys({});
    setRevealedAyahKeys({});
  };

  const triggerTurnEffect = useCallback((dir: 'next' | 'prev') => {
    turnSeqRef.current += 1;
    setPageTurn({ dir, seq: turnSeqRef.current });
  }, []);

  useEffect(() => {
    if (!pageTurn) return;
    const timer = window.setTimeout(() => {
      setPageTurn((prev) => (prev && prev.seq === pageTurn.seq ? null : prev));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pageTurn]);

  const handleStepMushafPage = (delta: number) => {
    const target = Math.max(1, Math.min(TOTAL_MUSHAF_PAGES, clampedMushafPage + delta));
    if (target === clampedMushafPage) return;
    handleJumpToPage(target);
    triggerTurnEffect(delta > 0 ? 'next' : 'prev');
  };

  useEffect(() => {
    if (variant !== 'standalone') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (clampedMushafPage < TOTAL_MUSHAF_PAGES) {
          handleJumpToPage(clampedMushafPage + 1);
          triggerTurnEffect('next');
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (clampedMushafPage > 1) {
          handleJumpToPage(clampedMushafPage - 1);
          triggerTurnEffect('prev');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [variant, clampedMushafPage, mushafDataset, triggerTurnEffect]);

  const handleSurahLetterClick = (unit: MushafLetterUnit, key: string) => {
    if (!hasPractice || mushafMode !== 'practice') return;

    if (surahCorrectMap[key]) {
      const next = { ...surahCorrectMap, [key]: false };
      setSurahCorrectMap(next);
      setSurahStatus({ msg: '', kind: null });
      return;
    }

    if (unit.isTarget) {
      onPlayChime?.(true);
      const next = { ...surahCorrectMap, [key]: true };
      setSurahCorrectMap(next);
      setSurahStatus({
        msg: practiceConfig?.hitMessage || 'أحسنت! إجابة صحيحة ✓',
        kind: 'ok',
      });

      const newFound = surahFoundCount + 1;
      if (newFound === surahTotalTargets && surahTotalTargets > 0) {
        setSurahStatus({
          msg:
            practiceConfig?.completeSingleMessage ||
            `ممتاز! وجدت كل ${practiceConfig?.targetLabel || 'المواضع المطلوبة'} في هذه الصفحة ✓`,
          kind: 'ok',
        });
        onTriggerConfetti?.();
        practiceConfig?.onPracticeComplete?.();
      }
    } else {
      onPlayChime?.(false);
      setSurahWrongKey(key);
      setSurahStatus({
        msg: practiceConfig?.missMessage || 'حاول مرة أخرى، هذا ليس الحرف المطلوب',
        kind: 'bad',
      });
      setTimeout(() => setSurahWrongKey(null), 450);
    }
  };

  const isEffectivePractice = hasPractice && mushafMode === 'practice';
  const hasTeacherActiveState =
    teacherTool !== 'cursor' ||
    isFocusMode ||
    isHifzHidden ||
    currentPageStrokes.length > 0;

  useEffect(() => {
    if (isFocusMode && !focusedAyahKey && pageAyahList.length > 0) {
      setFocusedAyahKey(pageAyahList[0].key);
    }
  }, [isFocusMode, focusedAyahKey, pageAyahList]);

  const handleToggleFocusMode = () => {
    if (isFocusMode) {
      setIsFocusMode(false);
      setFocusedAyahKey(null);
    } else {
      setIsFocusMode(true);
      setTeacherTool('cursor');
      if (pageAyahList.length > 0) {
        setFocusedAyahKey(pageAyahList[0].key);
      }
    }
  };

  const focusedAyahIdx = focusedAyahKey
    ? pageAyahList.findIndex((a) => a.key === focusedAyahKey)
    : -1;
  const focusedAyahMeta = focusedAyahIdx >= 0 ? pageAyahList[focusedAyahIdx] : null;

  const handleStepFocusedAyah = (delta: -1 | 1) => {
    if (pageAyahList.length === 0) return;
    const baseIdx = focusedAyahIdx >= 0 ? focusedAyahIdx : 0;
    const nextIdx = Math.max(0, Math.min(pageAyahList.length - 1, baseIdx + delta));
    setFocusedAyahKey(pageAyahList[nextIdx].key);
  };

  const handleToggleHifzMode = () => {
    if (isHifzHidden) {
      setIsHifzHidden(false);
      setRevealedWordKeys({});
      setRevealedAyahKeys({});
    } else {
      setIsHifzHidden(true);
      setTeacherTool('cursor');
      setRevealedWordKeys({});
      setRevealedAyahKeys({});
    }
  };

  const handleRevealNextAyah = () => {
    if (pageAyahList.length === 0) return;
    const nextHidden = pageAyahList.find((a) => !revealedAyahKeys[a.key]);
    if (!nextHidden) return;
    setRevealedAyahKeys((prev) => ({ ...prev, [nextHidden.key]: true }));
    if (isFocusMode) {
      setFocusedAyahKey(nextHidden.key);
    }
  };

  const handleRevealAllHifz = () => {
    const all: Record<string, boolean> = {};
    for (const a of pageAyahList) {
      all[a.key] = true;
    }
    setRevealedAyahKeys(all);
  };

  const handleHideAllHifz = () => {
    setRevealedWordKeys({});
    setRevealedAyahKeys({});
  };

  const handleAddStroke = useCallback(
    (stroke: TeacherStroke) => {
      setStrokesByPage((prev) => ({
        ...prev,
        [clampedMushafPage]: [...(prev[clampedMushafPage] || []), stroke],
      }));
    },
    [clampedMushafPage]
  );

  const handleRemoveStroke = useCallback(
    (strokeId: string) => {
      setStrokesByPage((prev) => {
        const list = prev[clampedMushafPage];
        if (!list || !list.some((s) => s.id === strokeId)) return prev;
        return {
          ...prev,
          [clampedMushafPage]: list.filter((s) => s.id !== strokeId),
        };
      });
    },
    [clampedMushafPage]
  );

  const handleUndoStroke = () => {
    setStrokesByPage((prev) => {
      const list = prev[clampedMushafPage];
      if (!list || list.length === 0) return prev;
      return {
        ...prev,
        [clampedMushafPage]: list.slice(0, -1),
      };
    });
  };

  const handleClearPageStrokes = () => {
    setStrokesByPage((prev) => {
      if (!prev[clampedMushafPage]?.length) return prev;
      const next = { ...prev };
      delete next[clampedMushafPage];
      return next;
    });
  };

  const handleWordTeacherClick = useCallback(
    (word: Extract<MushafLineItem, { kind: 'word' }>) => {
      const aKey = `${word.surahId}:${word.ayahNum}`;
      if (isHifzHidden) {
        if (revealedAyahKeys[aKey]) {
          setRevealedAyahKeys((prev) => ({ ...prev, [aKey]: false }));
        } else {
          setRevealedWordKeys((prev) => ({ ...prev, [word.keyPrefix]: !prev[word.keyPrefix] }));
        }
      }
      if (isFocusMode) {
        setFocusedAyahKey(aKey);
      }
    },
    [isHifzHidden, isFocusMode, revealedAyahKeys]
  );

  const handleAyahTeacherClick = useCallback(
    (surahId: number, ayahNum: number) => {
      const aKey = `${surahId}:${ayahNum}`;
      if (isHifzHidden) {
        setRevealedAyahKeys((prev) => ({ ...prev, [aKey]: !prev[aKey] }));
      }
      if (isFocusMode) {
        setFocusedAyahKey(aKey);
      }
    },
    [isHifzHidden, isFocusMode]
  );

  const handleSaveBookmark = (e?: React.FormEvent) => {
    e?.preventDefault();
    const pageSurah =
      focusedAyahMeta?.surahName ||
      activeSinglePageData?.surahNames[0] ||
      currentSurahEntry.name;
    const customLabel = bookmarkNoteInput.trim();
    const defaultLabel = focusedAyahMeta
      ? `سورة ${pageSurah} · آية ${toArabicDigits(focusedAyahMeta.ayahNum)}`
      : `سورة ${pageSurah} · صفحة ${toArabicDigits(clampedMushafPage)}`;
    const newBm: MushafBookmark = {
      id: `bm_${Date.now()}`,
      pageNum: clampedMushafPage,
      surahName: pageSurah,
      surahId: focusedAyahMeta?.surahId,
      ayahNum: focusedAyahMeta?.ayahNum,
      label: customLabel || defaultLabel,
      createdAt: Date.now(),
    };
    setBookmarks((prev) => {
      const filtered = prev.filter(
        (b) => !(b.pageNum === newBm.pageNum && b.ayahNum === newBm.ayahNum && b.label === newBm.label)
      );
      return [newBm, ...filtered].slice(0, 12);
    });
    setBookmarkNoteInput('');
  };

  const handleJumpToBookmark = (bm: MushafBookmark) => {
    handleJumpToPage(bm.pageNum);
    if (bm.surahId && bm.ayahNum) {
      setIsFocusMode(true);
      setFocusedAyahKey(`${bm.surahId}:${bm.ayahNum}`);
    }
    setIsBookmarksOpen(false);
  };

  const handleDeleteBookmark = (id: string) => {
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  };

  return (
    <div className="sub-panel active" id="sub-surah" data-variant={variant}>
      <div className="apply-toolbar-row mushaf-toolbar-row" id="surah-toolbar-row">
        <div className="apply-select-group mushaf-nav-controls">
          <div className="apply-select-wrap">
            <select
              id="surah-select"
              aria-label="اختر سورة"
              value={currentSurahEntry.name}
              onChange={(e) => handleSelectSurah(e.target.value)}
            >
              {mushafSurahs.map((surah) => (
                <option key={surah.id} value={surah.name}>
                  {toArabicDigits(surah.id)}. سورة {surah.name} ({toArabicDigits(surah.totalAyat)})
                </option>
              ))}
            </select>
            <ChevronDown className="apply-select-chevron" aria-hidden="true" />
          </div>

          <div className="apply-surah-nav-group" role="group" aria-label="التنقل بين صفحات المصحف">
            <button
              type="button"
              className="apply-surah-nav-btn"
              title="الصفحة السابقة"
              aria-label="الصفحة السابقة"
              disabled={clampedMushafPage <= 1}
              onClick={() => handleStepMushafPage(-1)}
            >
              <ChevronRight className="w-4 h-4" strokeWidth={2.4} />
            </button>
            <button
              type="button"
              className="apply-surah-nav-btn"
              title="الصفحة التالية"
              aria-label="الصفحة التالية"
              disabled={clampedMushafPage >= TOTAL_MUSHAF_PAGES}
              onClick={() => handleStepMushafPage(1)}
            >
              <ChevronLeft className="w-4 h-4" strokeWidth={2.4} />
            </button>
          </div>
        </div>

        <div className="mushaf-toolbar-actions">

          {hasPractice && (
            <div className="mushaf-mode-toggle" role="group" aria-label="وضع عرض المصحف">
              <button
                type="button"
                className={`mushaf-mode-btn ${mushafMode === 'practice' ? 'is-active' : ''}`}
                onClick={() => {
                  setMushafMode('practice');
                  setSurahStatus({ msg: '', kind: null });
                }}
              >
                <BookMarked className="w-3.5 h-3.5" aria-hidden="true" />
                <span>وضع التدريب</span>
              </button>
              <button
                type="button"
                className={`mushaf-mode-btn ${mushafMode === 'reading' ? 'is-active' : ''}`}
                onClick={() => {
                  setMushafMode('reading');
                  setSurahRevealed(false);
                  setSurahStatus({ msg: '', kind: null });
                }}
              >
                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span>وضع القراءة</span>
              </button>
            </div>
          )}

          <div className="mushaf-zoom-control" role="group" aria-label="تكبير وتصغير الآيات">
            <button
              type="button"
              className="mushaf-zoom-btn"
              disabled={!canZoomIn}
              onClick={() => handleStepZoom(1)}
              title="تكبير الآيات"
              aria-label="تكبير الآيات"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`mushaf-zoom-readout ${mushafZoom !== 1 ? 'is-modified' : ''}`}
              disabled={mushafZoom === 1}
              onClick={() => setMushafZoom(1)}
              title={mushafZoom === 1 ? 'الحجم الافتراضي للآيات' : 'إعادة الحجم إلى ١٠٠٪'}
              aria-label={`نسبة تكبير الآيات ${toArabicDigits(Math.round(mushafZoom * 100))} بالمئة`}
            >
              {toArabicDigits(Math.round(mushafZoom * 100))}٪
            </button>
            <button
              type="button"
              className="mushaf-zoom-btn"
              disabled={!canZoomOut}
              onClick={() => handleStepZoom(-1)}
              title="تصغير الآيات"
              aria-label="تصغير الآيات"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            className={`mushaf-tajweed-toggle-btn ${mushafTajweed ? 'is-active' : ''}`}
            aria-pressed={mushafTajweed}
            aria-label={mushafTajweed ? 'التجويد مفعّل، اضغط للإيقاف' : 'التجويد متوقف، اضغط للتفعيل'}
            onClick={() => setMushafTajweed((prev) => !prev)}
            title={mushafTajweed ? 'إيقاف ألوان التجويد' : 'تفعيل ألوان التجويد'}
          >
            <Palette className="w-3.5 h-3.5" aria-hidden="true" />
            <span>التجويد</span>
            <span className="mushaf-tajweed-switch" aria-hidden="true">
              <span className="mushaf-tajweed-switch-knob" />
            </span>
          </button>

          <button
            type="button"
            className={`mushaf-teacher-toggle-btn ${isTeacherDockOpen ? 'is-open' : ''} ${
              hasTeacherActiveState ? 'has-active' : ''
            }`}
            aria-expanded={isTeacherDockOpen}
            aria-pressed={isTeacherDockOpen}
            onClick={() => setIsTeacherDockOpen((prev) => !prev)}
            title="أدوات المعلم للحصة الأونلاين (قلم، ليزر، تركيز آية، تسميع، علامة التوقف)"
          >
            <PenTool className="w-3.5 h-3.5" aria-hidden="true" />
            <span>أدوات المعلم</span>
          </button>

          {variant === 'standalone' && onTogglePresentationMode && (
            <button
              type="button"
              className={`mushaf-presentation-btn ${isPresentationMode ? 'is-active' : ''}`}
              aria-pressed={isPresentationMode}
              onClick={onTogglePresentationMode}
              title={isPresentationMode ? 'إنهاء ملء الشاشة (Esc)' : 'تكبير العرض للبث والشاشة الكاملة'}
            >
              {isPresentationMode ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>إنهاء العرض</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>ملء الشاشة</span>
                </>
              )}
            </button>
          )}

          {isEffectivePractice && (
            <div
              className={`counter-pill ${
                surahTotalTargets > 0 && surahFoundCount === surahTotalTargets ? 'is-complete' : ''
              }`}
              id="surah-counter"
              aria-live="polite"
            >
              وجدت {toArabicDigits(surahFoundCount)} من {toArabicDigits(surahTotalTargets)}
            </div>
          )}
        </div>
      </div>

      {isTeacherDockOpen && (
        <div className="mushaf-teacher-dock" role="toolbar" aria-label="أدوات المعلم التفاعلية أثناء الحصة">
          <div className="mushaf-teacher-dock-row">
            <div className="mushaf-teacher-group" role="group" aria-label="أدوات القلم والمؤشر">
              <button
                type="button"
                className={`mushaf-teacher-btn ${teacherTool === 'cursor' ? 'is-active' : ''}`}
                onClick={() => setTeacherTool('cursor')}
                title="مؤشر عادي للتصفح والضغط على الآيات"
              >
                <MousePointer className="w-3.5 h-3.5" aria-hidden="true" />
                <span>تصفح</span>
              </button>
              <button
                type="button"
                className={`mushaf-teacher-btn ${teacherTool === 'pen' ? 'is-active' : ''}`}
                onClick={() => setTeacherTool(teacherTool === 'pen' ? 'cursor' : 'pen')}
                title="قلم شرح للرسم أو التحويط على الحروف"
              >
                <PenTool className="w-3.5 h-3.5" aria-hidden="true" />
                <span>قلم</span>
              </button>
              <button
                type="button"
                className={`mushaf-teacher-btn ${teacherTool === 'highlighter' ? 'is-active' : ''}`}
                onClick={() =>
                  setTeacherTool(teacherTool === 'highlighter' ? 'cursor' : 'highlighter')
                }
                title="قلم تظليل شفاف فوق الكلمات"
              >
                <Highlighter className="w-3.5 h-3.5" aria-hidden="true" />
                <span>تظليل</span>
              </button>
              <button
                type="button"
                className={`mushaf-teacher-btn ${teacherTool === 'laser' ? 'is-active' : ''}`}
                onClick={() => setTeacherTool(teacherTool === 'laser' ? 'cursor' : 'laser')}
                title="مؤشر ليزر مؤقت للإشارة دون ترك علامات"
              >
                <LocateFixed className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ليزر</span>
              </button>
              <button
                type="button"
                className={`mushaf-teacher-btn ${teacherTool === 'eraser' ? 'is-active' : ''}`}
                disabled={currentPageStrokes.length === 0}
                onClick={() => setTeacherTool(teacherTool === 'eraser' ? 'cursor' : 'eraser')}
                title="ممحاة لإزالة رسم محدد"
              >
                <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ممحاة</span>
              </button>

              {(teacherTool === 'pen' || teacherTool === 'highlighter') && (
                <div className="mushaf-teacher-colors" role="group" aria-label="لون القلم">
                  {TEACHER_PEN_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`mushaf-color-dot ${teacherPenColor === c.hex ? 'is-selected' : ''}`}
                      style={{ backgroundColor: c.hex }}
                      onClick={() => setTeacherPenColor(c.hex)}
                      title={c.label}
                      aria-label={c.label}
                      aria-pressed={teacherPenColor === c.hex}
                    />
                  ))}
                </div>
              )}

              {currentPageStrokes.length > 0 && (
                <>
                  <button
                    type="button"
                    className="mushaf-teacher-btn is-subtle"
                    onClick={handleUndoStroke}
                    title="تراجع عن آخر خطوة رسم"
                  >
                    <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>تراجع</span>
                  </button>
                  <button
                    type="button"
                    className="mushaf-teacher-btn is-danger-subtle"
                    onClick={handleClearPageStrokes}
                    title="مسح رسومات هذه الصفحة"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>مسح</span>
                  </button>
                </>
              )}
            </div>

            <div className="mushaf-teacher-divider" aria-hidden="true" />

            <div className="mushaf-teacher-group" role="group" aria-label="وضع التركيز على آية">
              <button
                type="button"
                className={`mushaf-teacher-btn ${isFocusMode ? 'is-active' : ''}`}
                aria-pressed={isFocusMode}
                onClick={handleToggleFocusMode}
                title="تعتيم باقي الصفحة وإضاءة آية واحدة لمنع تشتت الطفل"
              >
                <ScanEye className="w-3.5 h-3.5" aria-hidden="true" />
                <span>تركيز آية</span>
              </button>

              {isFocusMode && pageAyahList.length > 0 && (
                <div className="mushaf-teacher-stepper">
                  <button
                    type="button"
                    className="mushaf-teacher-step-btn"
                    disabled={focusedAyahIdx <= 0}
                    onClick={() => handleStepFocusedAyah(-1)}
                    title="الآية السابقة"
                    aria-label="الآية السابقة"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                  <span className="mushaf-teacher-step-label">
                    {focusedAyahMeta
                      ? `آية ${toArabicDigits(focusedAyahMeta.ayahNum)}`
                      : 'اختر آية'}
                  </span>
                  <button
                    type="button"
                    className="mushaf-teacher-step-btn"
                    disabled={focusedAyahIdx >= pageAyahList.length - 1}
                    onClick={() => handleStepFocusedAyah(1)}
                    title="الآية التالية"
                    aria-label="الآية التالية"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="mushaf-teacher-divider" aria-hidden="true" />

            <div className="mushaf-teacher-group" role="group" aria-label="أدوات التسميع والإخفاء">
              <button
                type="button"
                className={`mushaf-teacher-btn ${isHifzHidden ? 'is-active' : ''}`}
                aria-pressed={isHifzHidden}
                onClick={handleToggleHifzMode}
                title="إخفاء كلمات الآيات للتسميع مع إبقاء أرقام الآيات ظاهرة"
              >
                {isHifzHidden ? (
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{isHifzHidden ? 'إنهاء التسميع' : 'إخفاء للتسميع'}</span>
              </button>

              {isHifzHidden && (
                <>
                  <button
                    type="button"
                    className="mushaf-teacher-btn is-subtle"
                    onClick={handleRevealNextAyah}
                    title="كشف الآية التالية كاملة بالتدريج"
                  >
                    <span>كشف آية</span>
                  </button>
                  <button
                    type="button"
                    className="mushaf-teacher-btn is-subtle"
                    onClick={handleRevealAllHifz}
                    title="كشف جميع آيات الصفحة"
                  >
                    <span>كشف الكل</span>
                  </button>
                  <button
                    type="button"
                    className="mushaf-teacher-btn is-subtle"
                    onClick={handleHideAllHifz}
                    title="إعادة إخفاء جميع الكلمات"
                  >
                    <span>إخفاء الكل</span>
                  </button>
                </>
              )}
            </div>

            <div className="mushaf-teacher-divider" aria-hidden="true" />

            <div className="mushaf-teacher-group" role="group" aria-label="علامة التوقف">
              <button
                type="button"
                className={`mushaf-teacher-btn ${currentPageBookmark ? 'is-bookmarked' : ''}`}
                onClick={() => handleSaveBookmark()}
                title="حفظ الصفحة والآية الحالية كعلامة توقف للطالب"
              >
                {currentPageBookmark ? (
                  <BookmarkCheck className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>حفظ الموضع</span>
              </button>

              <button
                type="button"
                className={`mushaf-teacher-btn ${isBookmarksOpen ? 'is-active' : ''}`}
                aria-expanded={isBookmarksOpen}
                onClick={() => setIsBookmarksOpen((prev) => !prev)}
                title="عرض العلامات المحفوظة للطلاب"
              >
                <span>العلامات ({toArabicDigits(bookmarks.length)})</span>
              </button>
            </div>
          </div>

          {isBookmarksOpen && (
            <div className="mushaf-bookmarks-drawer">
              <form className="mushaf-bookmark-form" onSubmit={handleSaveBookmark}>
                <input
                  type="text"
                  className="mushaf-bookmark-input"
                  value={bookmarkNoteInput}
                  onChange={(e) => setBookmarkNoteInput(e.target.value)}
                  placeholder="اسم الطالب أو ملاحظة (اختياري، مثل: أحمد — سورة النبأ)"
                  aria-label="اسم الطالب أو عنوان علامة التوقف"
                />
                <button type="submit" className="mushaf-teacher-btn is-active">
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>إضافة علامة هنا</span>
                </button>
              </form>

              {bookmarks.length > 0 ? (
                <div className="mushaf-bookmarks-list">
                  {bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className={`mushaf-bookmark-item ${
                        bm.pageNum === clampedMushafPage ? 'is-current' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="mushaf-bookmark-jump"
                        onClick={() => handleJumpToBookmark(bm)}
                      >
                        <BookmarkCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        <span className="mushaf-bookmark-label">{bm.label}</span>
                        <span className="mushaf-bookmark-meta">
                          ص {toArabicDigits(bm.pageNum)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="mushaf-bookmark-del"
                        onClick={() => handleDeleteBookmark(bm.id)}
                        aria-label={`حذف علامة ${bm.label}`}
                        title="حذف العلامة"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mushaf-bookmarks-empty">
                  لا توجد علامات توقف محفوظة بعد — اضغط «حفظ الموضع» لحفظ صفحة الطالب والعودة إليها بضغطة واحدة.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {isEffectivePractice && practiceConfig && (
        <div className="instruction">
          اضغط على <span className="apply-instruction-accent">{practiceConfig.targetLabel}</span> في الصفحة
        </div>
      )}

      <div
        className={`quran-frame ${
          isEffectivePractice && surahTotalTargets > 0 && surahFoundCount === surahTotalTargets
            ? 'is-solved'
            : ''
        }`}
        id="surah-frame"
      >
        <svg
          className="tile-deco-pattern"
          viewBox="0 0 120 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="100" cy="20" r="52" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.35" />
          <circle cx="100" cy="20" r="38" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
          <circle cx="100" cy="20" r="22" stroke="currentColor" strokeWidth="1" opacity="0.5" />
          <circle cx="100" cy="20" r="8" fill="currentColor" opacity="0.25" />
          <rect x="76" y="-4" width="48" height="48" rx="6" transform="rotate(45 100 20)" stroke="currentColor" strokeWidth="1" opacity="0.4" />
          <rect x="76" y="-4" width="48" height="48" rx="6" stroke="currentColor" strokeWidth="1" opacity="0.4" />
        </svg>

        <div
          className={`mushaf-inner-frame ${isEffectivePractice ? 'is-practice-mode' : 'is-reading-mode'} ${
            pageTurn ? 'is-turning' : ''
          } ${mushafZoom > 1 ? 'is-zoomed' : ''}`}
          style={{ '--mushaf-zoom': mushafZoom } as React.CSSProperties}
        >
          <div className="mushaf-spread-stage">
            <div className="mushaf-side-nav-rail is-prev">
              <button
                type="button"
                className="mushaf-side-nav-btn"
                title="الصفحة السابقة"
                aria-label="الصفحة السابقة"
                disabled={clampedMushafPage <= 1}
                onClick={() => handleStepMushafPage(-1)}
              >
                <ChevronRight className="w-5 h-5" strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>

            <div
              className="mushaf-book-spread is-single-page"
              data-turn-dir={pageTurn?.dir}
              data-turn-phase={pageTurn ? (pageTurn.seq % 2 === 0 ? 'a' : 'b') : undefined}
              onAnimationEnd={(e) => {
                if (pageTurn && e.target === e.currentTarget) {
                  setPageTurn(null);
                }
              }}
              aria-label={`المصحف الشريف - صفحة ${toArabicDigits(clampedMushafPage)}`}
            >
            {[{ side: 'single' as const, pageNum: clampedMushafPage, pageData: activeSinglePageData }].map(
              ({ side, pageNum, pageData }) => (
              <article
                key={pageNum}
                className={`mushaf-page-sheet is-${side}-page ${pageNum <= 2 ? 'is-opening-spread' : ''}`}
                aria-label={`صفحة ${toArabicDigits(pageNum)}`}
              >
                <div className="mushaf-page-border-outer">
                  <div className="mushaf-page-border-inner">
                    <header className="mushaf-page-header">
                      <span className="mushaf-page-header-surah">
                        {pageData && pageData.surahNames.length > 0
                          ? pageData.surahNames.length === 1
                            ? `سُورَةُ ${pageData.surahNames[0]}`
                            : pageData.surahNames.join(' · ')
                          : `صفحة ${toArabicDigits(pageNum)}`}
                      </span>
                      <span className="mushaf-page-header-right">
                        {currentPageBookmark && (
                          <span className="mushaf-page-bookmark-tag" title={currentPageBookmark.label}>
                            <BookmarkCheck className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>علامة التوقف</span>
                          </span>
                        )}
                        <span className="mushaf-page-header-juz">
                          الجزء {toArabicDigits(pageData?.jozz || currentJozz)}
                        </span>
                      </span>
                    </header>

                    <div className={`mushaf-page-body ${pageNum <= 2 ? 'is-opening-spread' : 'is-standard-page'}`}>
                      {pageData ? (
                        pageData.rows.map((row) => {
                          if (row.kind === 'banner') {
                            const seg = row.surahMeta;
                            return (
                              <div
                                key={`${pageNum}_b_${row.line}_${seg.id}`}
                                className="mushaf-surah-banner"
                                aria-label={`سورة ${seg.name}`}
                              >
                                <div className="mushaf-banner-dashed-inset" aria-hidden="true" />

                                <div className="mushaf-banner-wing is-right">
                                  <div className="mushaf-wing-fill" aria-hidden="true" />
                                  <svg
                                    className="mushaf-wing-arc-svg"
                                    viewBox="0 0 28 60"
                                    preserveAspectRatio="none"
                                    fill="none"
                                    aria-hidden="true"
                                  >
                                    <path d="M28 0H22C10 2 3 15 3 30C3 45 10 58 22 60H28Z" fill="#EEF3FF" />
                                    <path
                                      d="M25 1.5C11 3.5 3.5 16 3.5 30C3.5 44 11 56.5 25 58.5"
                                      stroke="currentColor"
                                      strokeWidth="1.35"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                  <svg className="mushaf-wing-star" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                                    <path
                                      d="M10 1.5L12.1 7.9L18.5 10L12.1 12.1L10 18.5L7.9 12.1L1.5 10L7.9 7.9L10 1.5Z"
                                      fill="rgba(59, 130, 246, 0.14)"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                  <span className="mushaf-wing-text">{seg.rev}</span>
                                </div>

                                <div className="mushaf-surah-center">
                                  <svg className="mushaf-center-asterisk" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                                    <path
                                      d="M9 1.5V16.5M1.5 9H16.5M3.7 3.7L14.3 14.3M14.3 3.7L3.7 14.3"
                                      stroke="currentColor"
                                      strokeWidth="1.35"
                                      strokeLinecap="round"
                                    />
                                    <circle cx="9" cy="9" r="1.6" fill="#FFFFFF" stroke="currentColor" strokeWidth="1.1" />
                                  </svg>
                                  <span className="mushaf-surah-title">سُورَةُ {seg.name}</span>
                                  <svg className="mushaf-center-asterisk" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                                    <path
                                      d="M9 1.5V16.5M1.5 9H16.5M3.7 3.7L14.3 14.3M14.3 3.7L3.7 14.3"
                                      stroke="currentColor"
                                      strokeWidth="1.35"
                                      strokeLinecap="round"
                                    />
                                    <circle cx="9" cy="9" r="1.6" fill="#FFFFFF" stroke="currentColor" strokeWidth="1.1" />
                                  </svg>
                                </div>

                                <div className="mushaf-banner-wing is-left">
                                  <div className="mushaf-wing-fill" aria-hidden="true" />
                                  <svg
                                    className="mushaf-wing-arc-svg"
                                    viewBox="0 0 28 60"
                                    preserveAspectRatio="none"
                                    fill="none"
                                    aria-hidden="true"
                                  >
                                    <path d="M0 0H6C18 2 25 15 25 30C25 45 18 58 6 60H0Z" fill="#EEF3FF" />
                                    <path
                                      d="M3 1.5C17 3.5 24.5 16 24.5 30C24.5 44 17 56.5 3 58.5"
                                      stroke="currentColor"
                                      strokeWidth="1.35"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                  <span className="mushaf-wing-text">آيَاتُهَا</span>
                                  <span
                                    className={`mushaf-wing-ayah-badge ${seg.totalAyat >= 100 ? 'is-triple' : ''}`}
                                    aria-label={`${toArabicDigits(seg.totalAyat)} آية`}
                                  >
                                    <svg className="mushaf-wing-badge-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                      <path
                                        d="M12 1.8L14.8 4.6L18.8 4.6L19.4 8.6L22.2 12L19.4 15.4L18.8 19.4L14.8 19.4L12 22.2L9.2 19.4L5.2 19.4L4.6 15.4L1.8 12L4.6 8.6L5.2 4.6L9.2 4.6L12 1.8Z"
                                        fill="#FFFFFF"
                                        stroke="currentColor"
                                        strokeWidth="1.35"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                    <span className="mushaf-wing-badge-num">{toArabicDigits(seg.totalAyat)}</span>
                                  </span>
                                  <svg className="mushaf-wing-star" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                                    <path
                                      d="M10 1.5L12.1 7.9L18.5 10L12.1 12.1L10 18.5L7.9 12.1L1.5 10L7.9 7.9L10 1.5Z"
                                      fill="rgba(59, 130, 246, 0.14)"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </div>
                              </div>
                            );
                          }

                          if (row.kind === 'basmalah') {
                            return (
                              <div
                                key={`${pageNum}_m_${row.line}_${row.surahId}`}
                                className="mushaf-basmalah"
                                aria-hidden="true"
                              >
                                {'بِسۡ\u0640\u0640\u0640مِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِي\u0640\u0640\u0640مِ'}
                              </div>
                            );
                          }

                          return (
                            <MushafLineRow
                              key={`${pageNum}_t_${row.line}`}
                              items={row.items}
                              isCentered={row.isCentered}
                              isPractice={isEffectivePractice}
                              isTajweedEnabled={mushafTajweed}
                              correctMap={surahCorrectMap}
                              revealed={surahRevealed}
                              wrongKey={surahWrongKey}
                              onLetterClick={handleSurahLetterClick}
                              toArabicDigits={toArabicDigits}
                              zoomScale={mushafZoom}
                              focusedAyahKey={isFocusMode ? focusedAyahKey : null}
                              isHifzHidden={isHifzHidden}
                              revealedWordKeys={revealedWordKeys}
                              revealedAyahKeys={revealedAyahKeys}
                              onWordAction={
                                isHifzHidden || isFocusMode ? handleWordTeacherClick : undefined
                              }
                              onAyahAction={
                                isHifzHidden || isFocusMode ? handleAyahTeacherClick : undefined
                              }
                            />
                          );
                        })
                      ) : (
                        <div className="mushaf-page-loading">جارٍ تحميل صفحات المصحف الشريف...</div>
                      )}
                    </div>

                    <footer className="mushaf-page-footer">
                      <span className="mushaf-page-footer-flourish" aria-hidden="true">✦</span>
                      <span className="mushaf-page-footer-num">{toArabicDigits(pageNum)}</span>
                      <span className="mushaf-page-footer-flourish" aria-hidden="true">✦</span>
                    </footer>

                    <MushafTeacherOverlay
                      activeTool={teacherTool}
                      penColor={teacherPenColor}
                      strokes={currentPageStrokes}
                      onAddStroke={handleAddStroke}
                      onRemoveStroke={handleRemoveStroke}
                    />
                  </div>
                </div>
              </article>
            ))}
            </div>

            <div className="mushaf-side-nav-rail is-next">
              <button
                type="button"
                className="mushaf-side-nav-btn"
                title="الصفحة التالية"
                aria-label="الصفحة التالية"
                disabled={clampedMushafPage >= TOTAL_MUSHAF_PAGES}
                onClick={() => handleStepMushafPage(1)}
              >
                <ChevronLeft className="w-5 h-5" strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
          </div>

          {mushafTajweed && (
            <div className="mushaf-tajweed-legend" aria-label="دليل ألوان أحكام التجويد">
              {TAJWEED_LEGEND.map((item) => (
                <span key={item.kind} className="mushaf-tajweed-chip">
                  <span
                    className="mushaf-tajweed-dot"
                    style={{ backgroundColor: item.color }}
                    aria-hidden="true"
                  />
                  <span
                    className="mushaf-tajweed-label"
                    style={{ color: item.kind === 'idgham' ? '#526075' : item.color }}
                  >
                    {item.label}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mushaf-pagination-bar" role="navigation" aria-label="تصفح صفحات المصحف">
            <button
              type="button"
              className="mushaf-page-btn"
              disabled={clampedMushafPage <= 1}
              onClick={() => handleStepMushafPage(-1)}
            >
              <ChevronRight className="w-4 h-4" strokeWidth={2.4} />
              <span>الصفحة السابقة</span>
            </button>

            <div className="mushaf-page-jump">
              <select
                className="mushaf-page-select"
                aria-label="اختر صفحة المصحف"
                value={clampedMushafPage}
                onChange={(e) => handleJumpToPage(Number(e.target.value))}
              >
                {Array.from({ length: TOTAL_MUSHAF_PAGES }, (_, idx) => {
                  const pNum = idx + 1;
                  const pSurah = getPageSurahNames(mushafDataset?.pages[pNum - 1])[0];
                  return (
                    <option key={pNum} value={pNum}>
                      صفحة {toArabicDigits(pNum)}
                      {pSurah ? ` (${pSurah})` : ''}
                    </option>
                  );
                })}
              </select>
            </div>

            <button
              type="button"
              className="mushaf-page-btn"
              disabled={clampedMushafPage >= TOTAL_MUSHAF_PAGES}
              onClick={() => handleStepMushafPage(1)}
            >
              <span>الصفحة التالية</span>
              <ChevronLeft className="w-4 h-4" strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>

      {isEffectivePractice && surahStatus.msg && (
        <div
          role="status"
          aria-live="polite"
          className={`status-line word-extract-feedback ${
            surahStatus.kind === 'bad' ? 'is-wrong' : 'is-correct-letter'
          }`}
          id="surah-status"
        >
          {surahStatus.kind === 'bad' ? (
            <X className="w-4 h-4 shrink-0" strokeWidth={2.6} />
          ) : (
            <Check className="w-4 h-4 shrink-0" strokeWidth={2.6} />
          )}
          <span>{surahStatus.msg}</span>
        </div>
      )}

      {isEffectivePractice && (
        <div className="controls-row" id="surah-controls">
          <button
            type="button"
            className="btn"
            id="surah-reveal"
            onClick={() => setSurahRevealed(true)}
          >
            إظهار الحل
          </button>
          <button
            type="button"
            className="btn primary"
            id="surah-reset"
            onClick={() => {
              setSurahCorrectMap({});
              setSurahRevealed(false);
              setSurahStatus({ msg: '', kind: null });
            }}
          >
            إعادة المحاولة
          </button>
        </div>
      )}
    </div>
  );
};
