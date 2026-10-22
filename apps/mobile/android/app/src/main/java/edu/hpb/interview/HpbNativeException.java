package edu.hpb.interview;

/** Only fixed, public messages cross the JavaScript bridge; causes are never logged. */
final class HpbNativeException extends Exception {
    final String code;

    HpbNativeException(String code, String message) {
        super(message);
        this.code = code;
    }

    static HpbNativeException invalid() {
        return new HpbNativeException("INVALID_ARGUMENT", "请求参数格式不正确。");
    }
}
