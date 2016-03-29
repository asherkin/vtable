#include <cstdio>
#include <cstdlib>

void *operator new(size_t size) {
    return malloc(size);
}

void operator delete(void *ptr) {
 free(ptr);
}

#define TESTFUNC(decl) virtual decl { printf("%s\n", __PRETTY_FUNCTION__); }

struct COne {
  TESTFUNC( ~COne() )
  TESTFUNC( void One() )
  TESTFUNC( void Two() )
  TESTFUNC( void Three() )
  TESTFUNC( void Four() )
};

struct CTwo: public COne {
  TESTFUNC( void Two() )
  TESTFUNC( void Three(int) )
  TESTFUNC( void Three(float) )
  TESTFUNC( void Five() )
};

struct CThree {
  TESTFUNC( void Six() )
};

struct CFour: public CTwo, public CThree {
  TESTFUNC( void One() )
  TESTFUNC( void Two() )
  TESTFUNC( void Six() )
  TESTFUNC( void Seven() )
};

int main() {
  new COne();
  new CTwo();
  new CThree();
  new CFour();

  return 0;
}
