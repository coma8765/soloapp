import 'package:flutter/material.dart';
import 'api/generated/auth_api.dart' as auth;
import 'api/generated/whoami_api.dart';
import 'api/transport.dart';

void main() => runApp(const SoloApp());

class SoloApp extends StatelessWidget {
  const SoloApp({super.key, this.transport});
  final ApiTransport? transport;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Soloapp',
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff315be8)),
    ),
    home: AuthPage(transport: transport),
  );
}

class AuthPage extends StatefulWidget {
  const AuthPage({super.key, this.transport});
  final ApiTransport? transport;
  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  late final ApiTransport _transport = widget.transport ?? ApiTransport();
  late final auth.AuthApi _auth = auth.AuthApi(_transport);
  late final WhoamiApi _whoami = WhoamiApi(_transport);
  auth.ApiSession? _session;
  String? _message;
  bool _busy = false;

  Future<void> _run(Future<void> Function() operation) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await operation();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _message = error.message;
          if (error.status == 401) _session = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _message = 'Не удалось связаться с сервисом. Попробуйте снова.';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  Future<void> _login({bool register = false}) => _run(() async {
    final credentials = auth.ApiCredentials(
      username: _username.text.trim(),
      password: _password.text,
    );
    if (register) await _auth.authRegister(credentials);
    final session = await _auth.authLogin(credentials);
    _password.clear();
    if (mounted) {
      setState(() {
        _session = session;
      });
    }
  });

  Future<void> _identity() => _run(() async {
    final session = _session!;
    final identity = await _whoami.userId(session.accessToken);
    if (mounted) {
      setState(() {
        _message = 'Whoami подтвердил user-id: ${identity.userId}';
      });
    }
  });

  Future<void> _logout() => _run(() async {
    await _auth.authLogout(_session!.accessToken);
    if (mounted) {
      setState(() {
        _session = null;
      });
    }
  });

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    if (widget.transport == null) _transport.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xfff3f5fa),
    body: Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Soloapp',
                    style: Theme.of(context).textTheme.headlineLarge,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _session == null ? 'Вход в аккаунт' : 'Вы вошли в аккаунт',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 24),
                  if (_session == null) ...[
                    AutofillGroup(
                      child: Column(
                        children: [
                          TextField(
                            controller: _username,
                            enabled: !_busy,
                            autofillHints: const [AutofillHints.username],
                            decoration: const InputDecoration(
                              labelText: 'Имя пользователя',
                              border: OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 16),
                          TextField(
                            controller: _password,
                            enabled: !_busy,
                            obscureText: true,
                            autofillHints: const [AutofillHints.password],
                            onSubmitted: (_) => _login(),
                            decoration: const InputDecoration(
                              labelText: 'Пароль',
                              helperText: 'Для регистрации — от 12 байт',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _busy ? null : _login,
                      child: const Text('Войти'),
                    ),
                    TextButton(
                      onPressed: _busy ? null : () => _login(register: true),
                      child: const Text('Создать аккаунт'),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Сессия хранится в памяти этой вкладки. После обновления страницы потребуется войти снова.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ] else ...[
                    const Text('Ваш user-id'),
                    SelectableText(_session!.userId),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _busy ? null : _identity,
                      child: const Text('Проверить через Whoami'),
                    ),
                    TextButton(
                      onPressed: _busy ? null : _logout,
                      child: const Text('Выйти'),
                    ),
                  ],
                  if (_busy)
                    const Padding(
                      padding: EdgeInsets.only(top: 16),
                      child: LinearProgressIndicator(),
                    ),
                  if (_message != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: Text(_message!, key: const Key('message')),
                    ),
                  const SizedBox(height: 24),
                  const Text(
                    'Версия: ${String.fromEnvironment('APP_VERSION', defaultValue: 'development')}',
                    style: TextStyle(fontSize: 11),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
