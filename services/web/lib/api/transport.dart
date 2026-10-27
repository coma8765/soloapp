import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  const ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// The client owns no credentials; the UI retains its session only in memory.
class ApiTransport {
  ApiTransport({http.Client? client, Uri? origin})
    : client = client ?? http.Client(),
      origin = origin ?? Uri.base;
  final http.Client client;
  final Uri origin;

  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    required int expectedStatus,
    required Duration timeout,
    Map<String, dynamic>? body,
    String? accessToken,
  }) async {
    final request = http.Request(method, origin.resolve(path));
    request.headers['Accept'] = 'application/json';
    if (accessToken != null) {
      request.headers['Authorization'] = 'Bearer $accessToken';
    }
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    // Includes body consumption in the deadline. Mutations are never retried.
    final response = await client
        .send(request)
        .then(http.Response.fromStream)
        .timeout(timeout);
    if (response.statusCode != expectedStatus) {
      throw ApiException(response.statusCode, switch (response.statusCode) {
        400 => 'Проверьте имя пользователя и пароль.',
        401 => 'Неверный пароль или сессия завершилась.',
        409 => 'Это имя уже занято.',
        429 => 'Слишком много запросов. Попробуйте чуть позже.',
        _ => 'Сервис временно недоступен (${response.statusCode}).',
      });
    }
    if (response.body.isEmpty) return {};
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  void close() => client.close();
}
