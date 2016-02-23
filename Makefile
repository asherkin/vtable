DEBUG ?= 0

vtable.js: main.cpp build-libelf/lib/libelf.a is_debug
ifeq ($(DEBUG), 1)
	em++ --bind --std=c++14 --memory-init-file 0 -s ASSERTIONS=1 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s WARN_UNALIGNED=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
else
	em++ --bind --std=c++14 -O3 --llvm-lto 1 --closure 1 --memory-init-file 0 -s DEMANGLE_SUPPORT=1 -s ALLOW_MEMORY_GROWTH=1 -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s WARN_UNALIGNED=1 -s NO_FILESYSTEM=1 -s NO_BROWSER=1 -Ibuild-libelf/lib -Ilibelf-0.8.13/lib -o vtable.js main.cpp build-libelf/lib/libelf.a
endif

.PHONY: force clean distclean test deploy emscripten

is_debug: force
	@echo '$(DEBUG)' | cmp -s - $@ || echo '$(DEBUG)' > $@

deploy: gh-pages
	cd gh-pages && rm -rf .git && git init && git config user.name 'Travis CI' && git config user.email 'travis-ci@travis-ci.org' && git add . && git commit -m 'Deploy to GitHub Pages'
ifdef GH_REMOTE
	@cd gh-pages && echo '$(GH_REMOTE)' && git push --force --quiet '$(GH_REMOTE)' master:gh-pages > /dev/null 2>&1
endif

gh-pages: test.html vtable.js
	rm -rf gh-pages
	mkdir -p gh-pages
	cp test.html gh-pages/index.html
	cp vtable.js gh-pages/

emscripten: emsdk_portable
	emsdk_portable/emsdk update
	emsdk_portable/emsdk install latest
	emsdk_portable/emsdk activate --embedded latest
	@echo ''
	@echo '   ************************************************************'
	@echo '   * Don'\''t forget to run '\''source emsdk_portable/emsdk_env.sh'\'' *'
	@echo '   ************************************************************'
	@echo ''

emsdk_portable: emsdk-portable.tar.gz
	tar -xzf emsdk-portable.tar.gz && touch emsdk_portable

emsdk-portable.tar.gz:
	curl -o emsdk-portable.tar.gz 'https://s3.amazonaws.com/mozilla-games/emscripten/releases/emsdk-portable.tar.gz'

clean:
	rm -rf vtable.js gh-pages is_debug build-libelf libelf-0.8.13

distclean: clean
	rm -rf libelf-0.8.13.tar.gz engine_srv.so emsdk_portable emsdk-portable.tar.gz

test: test.js vtable.js engine_srv.so
	node test.js

engine_srv.so:
	curl -o engine_srv.so 'https://users.alliedmods.net/~asherkin/public/bins/source/tf2/bin/engine_srv.so'

build-libelf/lib/libelf.a: build-libelf libelf-0.8.13
	cd build-libelf && emconfigure ../libelf-0.8.13/configure --enable-shared=no && emmake make

build-libelf:
	mkdir -p build-libelf

libelf-0.8.13: libelf-0.8.13.tar.gz
	tar -xzf libelf-0.8.13.tar.gz && touch libelf-0.8.13

libelf-0.8.13.tar.gz:
	curl -o libelf-0.8.13.tar.gz 'https://fennec.limetech.org/libelf-0.8.13.tar.gz'
