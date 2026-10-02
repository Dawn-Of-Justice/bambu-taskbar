// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
    CloudPrinter, CloudRegion, ConnectionMode, IconPreviewRequest, PrinterConnectionInput, PrintStatus, PublicSettings, TrayAppApi,
} from './shared/types';

const api: TrayAppApi = {
    getSettings: () => ipcRenderer.invoke('getSettings'),
    updateSettings: (changes: Partial<PublicSettings>) => ipcRenderer.invoke('updateSettings', changes),
    savePrinter: (input: PrinterConnectionInput) => ipcRenderer.invoke('savePrinter', input),
    setConnectionMode: (mode: ConnectionMode) => ipcRenderer.invoke('setConnectionMode', mode),
    cloudSignIn: (email: string, password: string, region: CloudRegion) => ipcRenderer.invoke('cloudSignIn', email, password, region),
    cloudSignInWithBrowser: (region: CloudRegion) => ipcRenderer.invoke('cloudSignInWithBrowser', region),
    cloudVerifyCode: (code: string) => ipcRenderer.invoke('cloudVerifyCode', code),
    cloudVerifyTfa: (code: string) => ipcRenderer.invoke('cloudVerifyTfa', code),
    cloudResendCode: () => ipcRenderer.invoke('cloudResendCode'),
    cloudSignOut: () => ipcRenderer.invoke('cloudSignOut'),
    cloudListPrinters: () => ipcRenderer.invoke('cloudListPrinters'),
    cloudSelectPrinter: (printer: CloudPrinter) => ipcRenderer.invoke('cloudSelectPrinter', printer),
    getStatus: () => ipcRenderer.invoke('getStatus'),
    onStatusChanged: (callback: (status: PrintStatus) => void) => {
        const listener = (_: IpcRendererEvent, status: PrintStatus) => callback(status);
        ipcRenderer.on('statusChanged', listener);
        return () => { ipcRenderer.removeListener('statusChanged', listener); };
    },
    discoverPrinters: (seconds: number) => ipcRenderer.invoke('discoverPrinters', seconds),
    renderIcon: (request: IconPreviewRequest) => ipcRenderer.invoke('renderIcon', request),
    getAppInfo: () => ipcRenderer.invoke('getAppInfo'),
    sendTestNotification: () => ipcRenderer.invoke('sendTestNotification'),
    openExternal: (target: 'github' | 'setup-guide') => ipcRenderer.invoke('openExternal', target),
};

contextBridge.exposeInMainWorld('trayApp', api);
