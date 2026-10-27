import 'dart:async';
import 'dart:math';
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
  bool _reading = false;
  bool _sending = false;
  String? _error;
  String? _pendingId;
  String? _pendingText;

  @override
  void initState() {
    super.initState();
    unawaited(_read());
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _read());
  }

  Future<void> _read() async {
    if (_reading) return;
    _reading = true;
    try {
      final result = await _api.chatMessages(widget.token);
      if (mounted) {
        setState(() {
          _messages = result.messages;
          _error = null;
        });
      }
    } catch (error) {
      _handleError(error);
    } finally {
      _reading = false;
    }
  }

  void _handleError(Object error) {
    if (!mounted) return;
    if (error is ApiException && error.status == 401) {
      _timer?.cancel();
      widget.onExpired();
    } else {
      setState(() {
        _error = error is ApiException && error.status == 429
            ? 'Лимит: 10 сообщений за 10 секунд. Подождите немного.'
            : 'Связь с чатом прервана. Повторяем подключение…';
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
      await _api.chatSend(
        ApiChatSend(text: text, clientId: _pendingId!),
        widget.token,
      );
      if (!mounted) return;
      _text.clear();
      _pendingText = null;
      _pendingId = null;
      await _read();
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
    _timer?.cancel();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Divider(height: 32),
      Text('Общий чат', style: Theme.of(context).textTheme.titleLarge),
      const Text(
        'Для всех аккаунтов · обновление каждые 2 с · последние 100 сообщений',
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
