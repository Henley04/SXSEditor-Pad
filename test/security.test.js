const { expect } = require('chai');
const sinon = require('sinon');
const path = require('node:path');

// Global electron mock is provided by test/setup.js via Module._load hook.
// The mock's app.getPath returns '/tmp/sxseditor-test' for all paths.
const TEST_USER_DATA = '/tmp/sxseditor-test';

describe('Security Module', function () {
  let security;
  let authorizePath, isPathAllowed, isSystemPath;

  before(function () {
    // Clear the security module cache to force re-require with mocked electron
    const securityPath = require.resolve('../src/main/security');
    delete require.cache[securityPath];

    security = require('../src/main/security');
    authorizePath = security.authorizePath;
    isPathAllowed = security.isPathAllowed;
    isSystemPath = security.isSystemPath;
  });

  describe('isPathAllowed', function () {
    it('should allow paths in userData directory', function () {
      const filePath = path.join(TEST_USER_DATA, 'settings.json');
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should reject paths in system directories', function () {
      expect(isPathAllowed('/usr/bin')).to.be.false;
    });

    it('should reject arbitrary paths', function () {
      expect(isPathAllowed('/opt/random/file.txt')).to.be.false;
    });

    it('should reject sibling-prefix confusion', function () {
      // Without a separator after the allowed prefix, /tmp/sxseditor-test-evil
      // would be wrongly allowed because it startsWith /tmp/sxseditor-test.
      expect(isPathAllowed('/tmp/sxseditor-test-evil/steal.txt')).to.be.false;
    });
  });

  describe('authorizePath', function () {
    it('should authorize a path and allow subsequent access', function () {
      const filePath = '/opt/projects/test.sxs';
      authorizePath(filePath);
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should authorize the directory of a path', function () {
      const filePath = '/opt/projects/subdir/test.sxs';
      authorizePath(filePath);
      const siblingFile = path.join(path.dirname(filePath), 'other.txt');
      expect(isPathAllowed(siblingFile)).to.be.true;
    });

    it('should handle empty string gracefully', function () {
      authorizePath('');
    });

    it('should handle null gracefully', function () {
      authorizePath(null);
    });

    it('should handle undefined gracefully', function () {
      authorizePath(undefined);
    });

    it('should evict old entries when exceeding 1000', function () {
      for (let i = 0; i < 1100; i++) {
        authorizePath(`/tmp/path${i}/file.txt`);
      }
      expect(isPathAllowed('/tmp/path1099/file.txt')).to.be.true;
    });
  });

  describe('isSystemPath', function () {
    it('should detect /etc as system path', function () {
      expect(isSystemPath('/etc')).to.be.true;
    });

    it('should detect /etc/passwd as system path', function () {
      expect(isSystemPath('/etc/passwd')).to.be.true;
    });

    it('should detect /root as system path', function () {
      expect(isSystemPath('/root')).to.be.true;
    });

    it('should detect /sys as system path', function () {
      expect(isSystemPath('/sys')).to.be.true;
    });

    it('should detect /proc as system path', function () {
      expect(isSystemPath('/proc')).to.be.true;
    });

    it('should detect /dev as system path', function () {
      expect(isSystemPath('/dev')).to.be.true;
    });

    it('should detect /boot as system path', function () {
      expect(isSystemPath('/boot')).to.be.true;
    });

    it('should not detect user paths as system path', function () {
      expect(isSystemPath(TEST_USER_DATA)).to.be.false;
    });

    it('should not detect /tmp as system path', function () {
      expect(isSystemPath('/tmp')).to.be.false;
    });
  });
});
