// Thin wrapper over the few user32/kernel32 calls needed to find Orca's window and bring it to
// the front. Windows only; every function throws elsewhere. Adapted from the OrcaSlicer plugin.
import koffi from "koffi";

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GW_OWNER = 4;
const SW_RESTORE = 9;
const VK_MENU = 0x12;

// sizeof(INPUT) on 64-bit Windows (x64 and arm64). KEYBDINPUT sits at offset 8:
//   +8 WORD wVk, +10 WORD wScan, +12 DWORD dwFlags, +16 DWORD time, +24 ULONG_PTR dwExtraInfo
const INPUT_SIZE = 40;

type Api = ReturnType<typeof load>;
let api: Api | undefined;
let loadError: unknown;

function load() {
	if (process.platform !== "win32") throw new Error("Bringing Orca to the front only works on Windows.");
	if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported CPU: ${process.arch}`);

	const user32 = koffi.load("user32.dll");
	const kernel32 = koffi.load("kernel32.dll");
	const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
	koffi.alias("HWND", HANDLE);

	return {
		SendInput: user32.func("uint32_t __stdcall SendInput(uint32_t cInputs, const uint8_t *pInputs, int cbSize)"),
		SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(HWND hWnd)"),
		GetLastActivePopup: user32.func("HWND __stdcall GetLastActivePopup(HWND hWnd)"),
		FindWindowExW: user32.func("HWND __stdcall FindWindowExW(HWND hWndParent, HWND hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)"),
		GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)"),
		GetWindow: user32.func("HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)"),
		IsWindowVisible: user32.func("int __stdcall IsWindowVisible(HWND hWnd)"),
		IsIconic: user32.func("int __stdcall IsIconic(HWND hWnd)"),
		ShowWindow: user32.func("int __stdcall ShowWindow(HWND hWnd, int nCmdShow)"),
		OpenProcess: kernel32.func("HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)"),
		QueryFullProcessImageNameW: kernel32.func("int __stdcall QueryFullProcessImageNameW(HANDLE hProcess, uint32_t dwFlags, _Out_ uint8_t *lpExeName, _Inout_ uint32_t *lpdwSize)"),
		CloseHandle: kernel32.func("int __stdcall CloseHandle(HANDLE hObject)"),
	};
}

function win(): Api {
	if (api) return api;
	if (loadError) throw loadError; // a second load() would only fail with "duplicate type"
	try {
		return (api = load());
	} catch (err) {
		loadError = err;
		throw err;
	}
}

/** Taps Alt. Windows only lets the process that last sent input change the foreground window. */
function tapAlt(): void {
	const buf = Buffer.alloc(INPUT_SIZE * 2);
	for (const [i, up] of [[0, false], [1, true]] as const) {
		buf.writeUInt32LE(INPUT_KEYBOARD, i * INPUT_SIZE);
		buf.writeUInt16LE(VK_MENU, i * INPUT_SIZE + 8);
		buf.writeUInt32LE(up ? KEYEVENTF_KEYUP : 0, i * INPUT_SIZE + 12);
	}
	win().SendInput(2, buf, INPUT_SIZE);
}

function processPath(hwnd: unknown): string | undefined {
	const w = win();
	const pid = [0];
	if (!w.GetWindowThreadProcessId(hwnd, pid) || !pid[0]) return undefined;
	const handle = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
	if (!handle) return undefined;
	try {
		const buf = Buffer.alloc(1024 * 2);
		const size = [1024];
		if (w.QueryFullProcessImageNameW(handle, 0, buf, size) === 0) return undefined;
		return buf.toString("utf16le", 0, size[0] * 2);
	} finally {
		w.CloseHandle(handle);
	}
}

/** True for Orca's own executable (Orca.exe), and never for OrcaSlicer. */
export function isOrcaExecutable(path: string | undefined): boolean {
	if (!path) return false;
	const exe = path.split(/[\\/]/).pop() ?? "";
	return /^orca\.exe$/i.test(exe);
}

/** Orca's top-most visible window (main window or one of its dialogs), if it is running. */
function findOrcaWindow(): unknown {
	const w = win();
	for (let hwnd: unknown = null; ; ) {
		hwnd = w.FindWindowExW(null, hwnd, null, null);
		if (!hwnd) return undefined;
		if (w.IsWindowVisible(hwnd) !== 0 && !w.GetWindow(hwnd, GW_OWNER) && isOrcaExecutable(processPath(hwnd))) return hwnd;
	}
}

/**
 * Brings Orca's window to the front, restoring it if minimised.
 * @returns `false` when Orca's window isn't open.
 */
export function focusOrca(): boolean {
	const w = win();
	const main = findOrcaWindow();
	if (!main) return false;
	if (w.IsIconic(main) !== 0) w.ShowWindow(main, SW_RESTORE);
	const target = w.GetLastActivePopup(main) || main;
	tapAlt();
	w.SetForegroundWindow(target);
	return true;
}
