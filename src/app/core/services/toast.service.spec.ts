import {ToastService} from './toast.service';

describe('ToastService', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a success toast by default and dismisses it after the timeout', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const service = new ToastService();

    service.show('Saved locally');

    expect(service.toast()).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      message: 'Saved locally',
      kind: 'success',
    });

    vi.advanceTimersByTime(3599);
    expect(service.toast()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(service.toast()).toBeNull();
  });

  it('does not let an older timer dismiss a newer toast', () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
    const service = new ToastService();

    service.show('First');
    vi.advanceTimersByTime(1000);
    service.show('Second', 'warning');
    vi.advanceTimersByTime(2600);

    expect(service.toast()).toMatchObject({message: 'Second', kind: 'warning'});

    vi.advanceTimersByTime(1000);
    expect(service.toast()).toBeNull();
  });

  it('supports an immediate manual dismissal', () => {
    const service = new ToastService();

    service.show('Informational', 'info');
    service.dismiss();

    expect(service.toast()).toBeNull();
  });
});
