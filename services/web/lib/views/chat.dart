import 'dart:async';
import 'dart:math';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:flutter/material.dart';
import '../api/generated/app_api_api.dart';
import '../api/transport.dart';

/// All signed-in accounts share this room. Credentials remain in tab memory.
class ChatPanel extends StatefulWidget {
  const ChatPanel({
    super.key,
    required this.transport,
    required this.token,
    required this.userId,
    required this.onExpired,
  });
  final ApiTransport transport;
  final String token;
  final String userId;
  final VoidCallback onExpired;
  @override
  State<ChatPanel> createState() => _ChatPanelState();
}

class _ChatPanelState extends State<ChatPanel> {
  final _text = TextEditingController();
  final _random = Random.secure();
  late final AppApiApi _api = AppApiApi(widget.transport);
  Timer? _timer;
  List<ApiChatMessage> _messages = [];
  Timer? _watchdog;
  WebSocketChannel? _socket;
  StreamSubscription<dynamic>? _subscription;
  int _generation = 0;
  int _attempt = 0;
  bool _connected = false;
  bool _sending = false;
  String? _error;
  String? _pendingId;
  String? _pendingText;

  @override
  void initState() {
    super.initState();
    unawaited(_connect());
  }

  void _merge(Iterable<ApiChatMessage> incoming) {
    final byId = {for (final m in _messages) m.id: m};
    for (final m in incoming) {
      byId[m.id] = m;
    }
    final sorted = byId.values.toList()
      ..sort((a, b) {
        final left = a.id.split('-');
        final right = b.id.split('-');
        final time = BigInt.parse(left[0]).compareTo(BigInt.parse(right[0]));
        return time != 0
            ? time
            : BigInt.parse(left[1]).compareTo(BigInt.parse(right[1]));
      });
    _messages = sorted.length > 100
        ? sorted.sublist(sorted.length - 100)
        : sorted;
  }

  Future<void> _connect() async {
    final generation = ++_generation;
    try {
      final ticket = await _api.chatSocketTicket(widget.token);
      if (!mounted || generation != _generation) return;
      final socket = widget.transport.openSocket(
        AppApiApi.chatSocketPath,
        ticket.ticket,
      );
      _socket = socket;
      await socket.ready.timeout(const Duration(seconds: 8));
      if (!mounted || generation != _generation) {
        unawaited(socket.sink.close());
        return;
      }
      _attempt = 0;
      setState(() {
        _connected = true;
        _error = null;
      });
      void deadline() {
        _watchdog?.cancel();
        _watchdog = Timer(
          const Duration(seconds: 40),
          () => _retry(generation),
        );
      }

      deadline();
      _subscription = socket.stream.listen(
        (raw) {
          if (!mounted || generation != _generation) return;
          try {
            final event = jsonDecode(raw as String) as Map<String, dynamic>;
            setState(() {
              if (event['type'] == 'history') {
                _merge(ApiChatHistory.fromJson(event).messages);
              } else if (event['type'] == 'message') {
                _merge([
                  ApiChatMessage.fromJson(
                    event['message'] as Map<String, dynamic>,
                  ),
                ]);
              }
            });
            deadline();
          } catch (_) {
            _retry(generation);
          }
        },
        onDone: () => _retry(generation),
        onError: (Object _) => _retry(generation),
      );
    } catch (error) {
      if (!mounted || generation != _generation) return;
      if (error is ApiException && error.status == 401) {
        _generation++;
        widget.onExpired();
      } else {
        _retry(generation);
      }
    }
  }

  void _retry(int generation) {
    if (!mounted || generation != _generation) return;
    _generation++;
    _watchdog?.cancel();
    unawaited(_subscription?.cancel());
    unawaited(_socket?.sink.close());
    _socket = null;
    setState(() {
      _connected = false;
      _error = 'Связь с чатом прервана. Переподключаемся…';
    });
    final delay =
        min(10000, 500 * (1 << min(_attempt++, 5))) + _random.nextInt(300);
    _timer?.cancel();
    _timer = Timer(Duration(milliseconds: delay), () => unawaited(_connect()));
  }

  void _handleError(Object error) {
    if (!mounted) return;
    if (error is ApiException && error.status == 401) {
      _timer?.cancel();
      _watchdog?.cancel();
      _generation++;
      unawaited(_socket?.sink.close());
      widget.onExpired();
    } else {
      setState(() {
        _error = error is ApiException && error.status == 429
            ? 'Лимит: 10 сообщений за 10 секунд. Подождите немного.'
            : 'Не удалось отправить сообщение. Попробуйте снова.';
      });
    }
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (_sending || text.isEmpty) return;
    if (_pendingText != text) {
      _pendingText = text;
      _pendingId = List.generate(
        16,
        (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
    }
    setState(() {
      _sending = true;
    });
    try {
      final message = await _api.chatSend(
        ApiChatSend(text: text, clientId: _pendingId!),
        widget.token,
      );
      if (!mounted) return;
      _text.clear();
      _pendingText = null;
      _pendingId = null;
      setState(() {
        _merge([message]);
        _error = null;
      });
    } catch (error) {
      _handleError(error);
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    _watchdog?.cancel();
    unawaited(_subscription?.cancel());
    unawaited(_socket?.sink.close());
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Divider(height: 32),
      Text('Общий чат', style: Theme.of(context).textTheme.titleLarge),
      Text(
        _connected
            ? 'Для всех аккаунтов · онлайн · последние 100 сообщений'
            : 'Подключаемся к общему чату…',
        key: const Key('chat-status'),
      ),
      const SizedBox(height: 12),
      SizedBox(
        height: 260,
        child: _messages.isEmpty
            ? const Center(child: Text('Пока нет сообщений. Напишите первым.'))
            : ListView.builder(
                reverse: true,
                itemCount: _messages.length,
                itemBuilder: (context, index) {
                  final message = _messages[_messages.length - index - 1];
                  final mine = message.userId == widget.userId;
                  final time = DateTime.fromMillisecondsSinceEpoch(
                    message.sentAt,
                  ).toLocal();
                  return Card(
                    color: mine
                        ? Theme.of(context).colorScheme.primaryContainer
                        : null,
                    child: Padding(
                      padding: const EdgeInsets.all(10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${mine ? 'Вы' : message.userId.substring(0, 8)} · ${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}',
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                          SelectableText(message.text),
                        ],
                      ),
                    ),
                  );
                },
              ),
      ),
      if (_error != null) Text(_error!, key: const Key('chat-error')),
      TextField(
        key: const Key('chat-input'),
        controller: _text,
        enabled: !_sending,
        maxLength: 1000,
        decoration: const InputDecoration(labelText: 'Сообщение'),
        onSubmitted: (_) => _send(),
      ),
      FilledButton(
        onPressed: _sending ? null : _send,
        child: Text(_sending ? 'Отправка…' : 'Отправить'),
      ),
    ],
  );
}
