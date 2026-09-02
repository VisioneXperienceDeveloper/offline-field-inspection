import {TestBed} from '@angular/core/testing';
import {ConnectivityService} from './connectivity.service';

describe('ConnectivityService', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', {value: true, configurable: true});
    TestBed.configureTestingModule({providers: [ConnectivityService]});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('combines browser connectivity with the simulated offline override', () => {
    const service = TestBed.inject(ConnectivityService);

    expect(service.online()).toBe(true);
    expect(service.testMode()).toBe(false);

    service.toggleTestMode();
    expect(service.online()).toBe(false);
    expect(service.testMode()).toBe(true);

    service.setSimulatedOffline(false);
    expect(service.online()).toBe(true);
  });

  it('reacts to browser online and offline events', () => {
    const service = TestBed.inject(ConnectivityService);

    window.dispatchEvent(new Event('offline'));
    expect(service.online()).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(service.online()).toBe(true);
  });

  it('unregisters its browser event handlers when the injector is destroyed', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    TestBed.inject(ConnectivityService);

    const onlineHandler = addEventListener.mock.calls.find(([event]) => event === 'online')?.[1];
    const offlineHandler = addEventListener.mock.calls.find(([event]) => event === 'offline')?.[1];

    expect(onlineHandler).toBeDefined();
    expect(offlineHandler).toBeDefined();

    TestBed.resetTestingModule();

    expect(removeEventListener).toHaveBeenCalledWith('online', onlineHandler);
    expect(removeEventListener).toHaveBeenCalledWith('offline', offlineHandler);
  });
});
